import prisma from "../../config/prisma";
import { logger } from "../../utils/logger";
import { decryptFacebookSecret } from "../../utils/tokenCrypto";
import {
  getOrCreateConversation,
  getConversationHistory,
  saveMessage,
} from "./conversation.service";
import { computeBusinessChatReply } from "../chat/businessChatReply.service";
import { historyToLlmTurns, toPromptMessages } from "../chat/conversationTurns";
import { emitToBusiness, emitToConversation } from "../../utils/socket";

const FALLBACK_REPLY =
  "Sorry, we can't respond right now. Please try again or contact the business directly.";

export async function sendMessengerReply(
  recipientId: string,
  text: string,
  pageAccessToken: string,
) {
  const response = await fetch(
    `https://graph.facebook.com/v25.0/me/messages?access_token=${pageAccessToken}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
      }),
    },
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Messenger Send API error: ${JSON.stringify(error)}`);
  }

  return response.json();
}

/**
 * Send a media message via Messenger API (v25.0) using an attachment_id.
 */
export async function sendMessengerMedia(
  recipientId: string,
  attachmentId: string,
  type: "image" | "video" | "audio" | "file",
  pageAccessToken: string,
) {
  const response = await fetch(
    `https://graph.facebook.com/v25.0/me/messages?access_token=${pageAccessToken}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: {
          attachment: {
            type: type,
            payload: { attachment_id: attachmentId },
          },
        },
      }),
    },
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Messenger Media Send API error: ${JSON.stringify(error)}`);
  }

  return response.json();
}

export async function sendMessengerAction(
  recipientId: string,
  action: "mark_seen" | "typing_on" | "typing_off",
  pageAccessToken: string,
) {
  await fetch(
    `https://graph.facebook.com/v25.0/me/messages?access_token=${pageAccessToken}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        sender_action: action,
      }),
    },
  ).catch((err) => {
    logger.warn("messenger.sender_action_failed", {
      recipientId,
      action,
      error: String(err),
    });
  });
}

export async function handleMessengerMessage(
  pageId: string,
  senderId: string,
  messageText: string,
  externalId?: string,
  type?: string,
  mediaId?: string,
  mediaMetadata?: any,
) {
  // Idempotency: prevent processing same Message ID twice (Meta retries)
  if (externalId) {
    try {
      const inserted = await prisma.processedMessengerMessage.createMany({
        data: [{ messageMid: externalId }],
        skipDuplicates: true,
      });
      if (inserted.count === 0) {
        logger.debug("messenger.duplicate_mid_skipped", { externalId });
        return;
      }
    } catch (e: unknown) {
      logger.warn("messenger.idempotency_check_error", { error: String(e) });
    }
  }

  const page = await prisma.facebookPage.findFirst({
    where: { pageId, isActive: true },
    include: {
      businessProfile: {
        include: {
          externalDataSources: { where: { isActive: true } },
          crmIntegrations: { where: { isActive: true }, take: 1 },
        },
      },
    },
  });

  if (!page) {
    logger.error("messenger.page_not_found", { pageId });
    return;
  }
  if (!page.businessProfileId || !page.businessProfile) {
    logger.error("messenger.no_business_profile", { pageId });
    return;
  }

  let pageAccessToken: string;
  try {
    pageAccessToken = decryptFacebookSecret(page.pageAccessToken);
  } catch (e: unknown) {
    logger.error("messenger.decrypt_token_failed", {
      pageId,
      error: String(e),
    });
    return;
  }

  // Visual cues
  void sendMessengerAction(senderId, "mark_seen", pageAccessToken);
  void sendMessengerAction(senderId, "typing_on", pageAccessToken);

  const businessProfile = page.businessProfile;
  let conversation: any;

  try {
    // 1. Get or Create Conversation with Profile Sync
    let customerNameSet: string | undefined;
    let customerAvatarSet: string | undefined;

    const existing = await prisma.conversation.findFirst({
      where: { pageId, senderId, channel: "messenger" },
      select: { customerName: true, customerAvatar: true },
    });

    if (existing) {
       customerNameSet = existing.customerName ?? undefined;
       customerAvatarSet = existing.customerAvatar ?? undefined;
    }

    // PRODUCTION SYNC: If name is missing, fetch from Graph API
    if (!customerNameSet) {
      try {
        const { getFacebookUserProfile } = await import("./facebook.service");
        const profile = await getFacebookUserProfile(senderId, pageId, pageAccessToken);
        if (profile) {
          customerNameSet = profile.name;
          customerAvatarSet = profile.picture?.data?.url;
          logger.info("messenger.profile_synced", { senderId, name: customerNameSet });
        }
      } catch (e) {
        logger.warn("messenger.identity_fetch_failed", { error: String(e) });
      }
    }

    conversation = await getOrCreateConversation(pageId, senderId, page.businessProfileId, {
      channel: "messenger",
      customerName: customerNameSet,
      customerAvatar: customerAvatarSet,
    });

    logger.debug("messenger.processing_started", { 
      conversationId: conversation.id, 
      msgType: type || "text" 
    });

    // 2. Save User Message turn
    const userSaved = await saveMessage(conversation.id, "user", messageText, {
      externalId,
      type: type || "text",
      mediaId,
      mediaMetadata,
    });

    // Notify UI immediately
    emitToBusiness(page.businessProfileId, "new_message", {
      conversationId: conversation.id,
      message: userSaved,
    });
    emitToConversation(conversation.id, "new_message", {
      message: userSaved,
    });

    // 3. AI Mode Check (Manual Mode Exit)
    if (businessProfile.responseMode === "MANUAL") {
      logger.info("messenger.manual_mode_skip", { conversationId: conversation.id });
      void sendMessengerAction(senderId, "typing_off", pageAccessToken);
      return;
    }

    // 4. Compute AI Response
    const historyRows = await getConversationHistory(conversation.id);
    const historyForPrompt = toPromptMessages(historyRows);
    const historyTurns = historyToLlmTurns(historyForPrompt);

    const reply = await computeBusinessChatReply({
      businessProfile,
      messageText,
      historyTurns,
      channel: "messenger",
      mediaInfo: mediaId ? { id: mediaId, type: type || "image" } : undefined,
    });

    if (reply.action === "RESOLVE_CONVERSATION") {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: "RESOLVED" },
      });
      void sendMessengerAction(senderId, "typing_off", pageAccessToken);
      return;
    }

    const isAutoMode = businessProfile.responseMode === "AUTO";
    const status =
      reply.action === "HANDOFF_TO_HUMAN" || !isAutoMode
        ? "PENDING_REVIEW"
        : "SENT";

    // 5. Save AI turn (Draft or Sent)
    const modelSaved = await saveMessage(
      conversation.id,
      "model",
      reply.content || "",
      {
        status,
        aiReasoning: reply.reasoning,
        handoffCategory: reply.handoffCategory,
      },
    );

    // Pulse UI
    emitToBusiness(page.businessProfileId, "new_message", {
      conversationId: conversation.id,
      message: modelSaved,
    });
    emitToConversation(conversation.id, "new_message", {
      message: modelSaved,
    });

    if (status === "PENDING_REVIEW") {
      emitToBusiness(page.businessProfileId, "draft_received", {
        conversationId: conversation.id,
        message: modelSaved,
      });
    }

    // 6. Send API call if AUTO
    if (
      status === "SENT" &&
      reply.content &&
      reply.handoffCategory !== "SYSTEM_ERROR"
    ) {
      try {
        const platformRes = await sendMessengerReply(
          senderId,
          reply.content,
          pageAccessToken,
        );
        const mid = (platformRes as any)?.message_id;

        if (mid) {
          await prisma.conversationMessage.update({
            where: { id: modelSaved.id },
            data: { externalId: mid },
          });
        }
      } catch (sendErr: any) {
        logger.error("messenger.reply_send_failed", { error: sendErr.message });
      }
    }

    // 7. Critical UI Notification for System Errors
    if (reply.handoffCategory === "SYSTEM_ERROR") {
      emitToBusiness(page.businessProfileId, "system_critical_error", {
        conversationId: conversation.id,
        reason: reply.reasoning,
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("messenger.handle_failed", {
      pageId,
      senderId,
      error: message,
    });

    // UI Failure Signal
    if (page.businessProfileId && conversation) {
      const errorMsg = `Internal Technical Failure: ${message}`;
      const failMsg = await saveMessage(conversation.id, "model", errorMsg, {
        status: "FAILED",
        aiReasoning: message,
        handoffCategory: "SYSTEM_ERROR",
      });
      emitToBusiness(page.businessProfileId, "new_message", {
        conversationId: conversation.id,
        message: failMsg,
      });
      emitToBusiness(page.businessProfileId, "system_critical_error", {
        conversationId: conversation.id,
        reason: message,
      });
    }
  } finally {
    if (pageAccessToken) {
      void sendMessengerAction(senderId, "typing_off", pageAccessToken);
    }
  }
}
