import prisma from "../../config/prisma";
import { logger } from "../../utils/logger";
import { decryptFacebookSecret } from "../../utils/tokenCrypto";
import {
  getOrCreateConversation,
  getConversationHistory,
  saveMessage,
} from "./conversation.service";
import { computeBusinessChatReply } from "../chat/businessChatReply.service";
import {
  historyToLlmTurns,
  toPromptMessages,
} from "../chat/conversationTurns";
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
) {
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
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("messenger.decrypt_token_failed", { pageId, error: msg });
    return;
  }

  void sendMessengerAction(senderId, "mark_seen", pageAccessToken);
  void sendMessengerAction(senderId, "typing_on", pageAccessToken);

  const businessProfile = page.businessProfile;

    let conversation: any;
    try {
      // Fetch Meta Profile if identity info is missing
      let identity: { name?: string; avatar?: string } = {};
      const existing = await prisma.conversation.findFirst({
        where: { pageId, senderId, channel: "messenger" },
        select: { customerName: true, customerAvatar: true }
      });

      if (!existing || !existing.customerName) {
        const { getFacebookUserProfile } = await import("./facebook.service");
        const profile = await getFacebookUserProfile(senderId, pageId, pageAccessToken);
        if (profile) {
          identity.name = profile.name;
          identity.avatar = profile.picture?.data?.url;
        }
      }

      conversation = await getOrCreateConversation(
        pageId,
        senderId,
        page.businessProfileId,
        { 
          channel: "messenger",
          customerName: identity.name,
          customerAvatar: identity.avatar
        },
      );
    const historyRows = await getConversationHistory(conversation.id);
    const userSaved = await saveMessage(conversation.id, "user", messageText);
    emitToBusiness(page.businessProfileId, "new_message", {
      conversationId: conversation.id,
      message: userSaved,
    });
    emitToConversation(conversation.id, "new_message", {
      message: userSaved,
    });

    const historyForPrompt = toPromptMessages(historyRows);
    historyForPrompt.push({ role: "user", content: messageText });
    const historyTurns = historyToLlmTurns(historyForPrompt);
    
    // 3. Early Exit if Manual Mode
    // In MANUAL mode, we don't calculate any drafted replies automatically.
    // The agent will manually request a suggestion via the /suggest endpoint.
    if (businessProfile.responseMode === "MANUAL") {
      logger.info("messenger.manual_mode_skip", { 
        conversationId: conversation.id, 
        businessProfileId: businessProfile.id 
      });
      return;
    }

    const reply = await computeBusinessChatReply({
      businessProfile,
      messageText,
      historyTurns,
      channel: "messenger",
    });

    if (reply.action === "RESOLVE_CONVERSATION") {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: "RESOLVED" }
      });
      logger.info("messenger.conversation_resolved_by_ai", { conversationId: conversation.id });
      return;
    }

    const isAutoMode = businessProfile.responseMode === "AUTO";
    const status = reply.action === "HANDOFF_TO_HUMAN" || !isAutoMode ? "PENDING_REVIEW" : "SENT";

    const modelSaved = await saveMessage(conversation.id, "model", reply.content || "", {
      status,
      aiReasoning: reply.reasoning,
      handoffCategory: reply.handoffCategory
    });

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
          message: modelSaved
       });
    }

    if (status === "SENT" && reply.content && reply.handoffCategory !== "SYSTEM_ERROR") {
      try {
        const platformRes = await sendMessengerReply(senderId, reply.content, pageAccessToken);
        const mid = (platformRes as any)?.message_id;
        
        if (mid) {
          await prisma.conversationMessage.update({
            where: { id: modelSaved.id },
            data: { externalId: mid }
          });
        }
        
        logger.info("messenger.reply_sent", {
          pageId,
          senderId,
          mid,
          preview: reply.content.substring(0, 80),
        });
      } catch (sendErr: any) {
        logger.error("messenger.reply_send_failed", { error: sendErr.message });
      }
    }

    if (reply.handoffCategory === "SYSTEM_ERROR") {
       // Also ensure we send a 'new_message' pulse for the error bubble itself
       emitToBusiness(page.businessProfileId, "new_message", {
          conversationId: conversation.id,
          message: modelSaved,
       });

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
    
    // Safety cleanup: ensure typing indicator is off for the customer
    if (pageAccessToken) {
      void sendMessengerAction(senderId, "typing_off", pageAccessToken);
    }
    
    // Silent fail for customer, but alert the business
    if (page?.businessProfileId && conversation) {
        const errorMsg = `Internal Technical Failure: ${message}`;
       const modelSaved = await saveMessage(conversation.id, "model", errorMsg, {
          status: "FAILED",
          aiReasoning: `System Exception: ${message}`,
          handoffCategory: "SYSTEM_ERROR"
       });

       emitToBusiness(page.businessProfileId, "new_message", {
          conversationId: conversation.id,
          message: modelSaved,
       });

       emitToBusiness(page.businessProfileId, "system_critical_error", {
          conversationId: conversation.id,
          reason: message,
       });
    }
  }
}
