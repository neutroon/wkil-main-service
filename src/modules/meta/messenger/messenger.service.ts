import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import {
  getOrCreateConversation,
  getConversationHistory,
  saveMessage,
} from "../core/conversation.service";
import { AppError } from "@middlewares/errorHandler.middleware";
import { AgentClient } from "@modules/ai-agent/client/agent.client";

// ── Local shims (formerly @modules/ai-agent/chat/*, migrated to agent-svc) ──
function classifyInboundMessageSignal(p: { type?: string; messageText?: string; mediaId?: string; mediaMetadata?: unknown; [k: string]: unknown }) {
  return { shouldTriggerAi: !!p.messageText || !!p.mediaId, reason: "migrated-to-agent-svc" };
}
function toPromptMessages(rows: any[]): any[] {
  return rows.map((r) => ({ role: r.role, content: r.content ?? r.text ?? "" }));
}
function historyToLlmTurns(promptMessages: any[]): any[] {
  return promptMessages;
}
async function computeBusinessChatReply(params: {
  businessProfile: any;
  messageText?: string;
  historyTurns: any[];
  channel: string;
  mediaInfo?: any;
  conversationId: number;
  [k: string]: unknown;
}) {
  const messages = [
    ...params.historyTurns,
    { role: "user", content: params.messageText ?? "", media: params.mediaInfo },
  ];
  const run = await AgentClient.runAgent({
    business_profile_id: params.businessProfile?.id ?? params.businessProfile?.businessProfileId,
    user_id: params.businessProfile?.userId,
    messages,
    stage: "fast",
    channel: params.channel,
    conversation_id: params.conversationId,
  } as any);
  const text = (run as any)?.output?.content ?? (run as any)?.content ?? "";
  const action = text ? "REPLY" : "HANDOFF_TO_HUMAN";
  return {
    action,
    content: text,
    reasoning: (run as any)?.output?.reasoning ?? "",
    handoffCategory: text ? null : "NO_AGENT_OUTPUT",
  };
}
function initialCustomerReplyStatus(reply: { content?: string; action?: string }) {
  return reply.content ? "SENDING" : "FAILED";
}
function runSavedModelReplySideEffectsInBackground(_p: any) {
  // TODO: side-effects (socket emits, metrics) move to agent-svc; fire-and-forget log.
  setImmediate(() => logger.debug("messenger.model_side_effects_skipped_migrated"));
}
function scheduleFollowUpsForDeliveredReplyInBackground(_p: any) {
  setImmediate(() => logger.debug("messenger.followup_skipped_migrated"));
}



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
    throw new AppError(`Messenger Send API error: ${JSON.stringify(error)}`, 502);
  }

  return response.json();
}

/**
 * Send a media message via Messenger API (v25.0) using an attachment_id.
 */
export async function sendMessengerMedia(
  recipientId: string,
  attachmentId: string | null,
  type: "image" | "video" | "audio" | "file",
  pageAccessToken: string,
  url?: string,
) {
  const payload = attachmentId 
    ? { attachment_id: attachmentId } 
    : { url: url, is_reusable: true };

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
            payload: payload,
          },
        },
      }),
    },
  );

  if (!response.ok) {
    const error = await response.json();
    throw new AppError(`Messenger Media Send API error: ${JSON.stringify(error)}`, 502);
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
  if (externalId) {
    const existing = await prisma.conversationMessage.findFirst({
      where: { externalId },
      select: { id: true },
    });
    if (existing) {
      logger.info("messenger.message_already_exists", { externalId });
      return;
    }
  }

  const page = await prisma.facebookPage.findFirst({
    where: { pageId, isActive: true },
    include: {
      businessProfile: {
        include: {
          agentActionSources: { where: { isActive: true } },
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
       customerNameSet =
         existing.customerName?.trim().toLowerCase() === "guest customer"
           ? undefined
           : existing.customerName ?? undefined;
       customerAvatarSet = existing.customerAvatar ?? undefined;
    }

    // PRODUCTION SYNC: If name is missing, fetch from Graph API
    if (!customerNameSet) {
      try {
        const { getFacebookUserProfile } = await import("../facebook/facebook.service");
        const profile = await getFacebookUserProfile(senderId, pageId, pageAccessToken);
        if (profile) {
          customerNameSet = profile.name;
          customerAvatarSet = profile.pictureUrl || undefined;
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
    await saveMessage(conversation.id, "user", messageText, {
      externalId,
      type: type || "text",
      mediaId,
      mediaMetadata,
    });

    const inboundSignal = classifyInboundMessageSignal({
      type,
      messageText,
      mediaId,
      mediaMetadata,
    });
    if (!inboundSignal.shouldTriggerAi) {
      logger.info("messenger.passive_inbound_saved_without_ai", {
        conversationId: conversation.id,
        reason: inboundSignal.reason,
        type,
      });
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
      mediaInfo: mediaId ? {
        id: mediaId,
        type: type || "image",
        metadata: mediaMetadata,
      } : undefined,
      conversationId: conversation.id,
    });

    if (reply.action === "RESOLVE_CONVERSATION") {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: "RESOLVED" },
      });
      void sendMessengerAction(senderId, "typing_off", pageAccessToken);
      return;
    }

    const status = initialCustomerReplyStatus(reply);

    // 5. Save AI turn
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

    runSavedModelReplySideEffectsInBackground({
      businessProfileId: page.businessProfileId,
      conversationId: conversation.id,
      message: modelSaved,
      reply,
    });

    // 6. Send API call if AUTO
    if (
      status === "SENDING" &&
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
            data: { status: "SENT", externalId: mid },
          });
        }

        scheduleFollowUpsForDeliveredReplyInBackground({
          conversationId: conversation.id,
          businessProfileId: page.businessProfileId,
          message: modelSaved,
          reply,
        });
      } catch (sendErr: any) {
        logger.error("messenger.reply_send_failed", { error: sendErr.message });
        await prisma.conversationMessage.update({
          where: { id: modelSaved.id },
          data: { status: "FAILED" },
        });
      }
    }

    // 7. Critical UI Notification for System Errors
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
      const errorSaved = await saveMessage(conversation.id, "model", errorMsg, {
        status: "FAILED",
        aiReasoning: message,
        handoffCategory: "SYSTEM_ERROR",
      });
      runSavedModelReplySideEffectsInBackground({
        businessProfileId: page.businessProfileId,
        conversationId: conversation.id,
        message: errorSaved,
        reply: {
          action: "HANDOFF_TO_HUMAN",
          handoffCategory: "SYSTEM_ERROR",
          reasoning: message,
        },
      });
      const { syncMediaStatus } = await import("@modules/realtime/socketSync.service");
      syncMediaStatus({
        businessProfileId: page.businessProfileId,
        assetId: conversation.id,
        status: "SYNC_FAILED"
      });
    }
  } finally {
    if (pageAccessToken) {
      void sendMessengerAction(senderId, "typing_off", pageAccessToken);
    }
  }
}









