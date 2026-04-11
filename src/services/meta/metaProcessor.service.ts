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
import { getFacebookUserProfile } from "./facebook.service";

export type MetaPlatform = "messenger" | "whatsapp";

export interface MetaMessageJob {
  platform: MetaPlatform;
  identifier: string; // pageId for messenger, phoneNumberId for whatsapp
  senderId: string;   // customer PSID or phone number
  messageText: string;
  externalId?: string;
  msgType?: string;
  type?: string; 
  pageId?: string;
  phoneNumberId?: string;
  from?: string;
  mediaId?: string;
  mediaMetadata?: any;
  customerName?: string;
  commentId?: string;
  postId?: string;
  senderName?: string;
}

/**
 * High-Resilience Unified Meta Processor.
 * Handles the end-to-end lifecycle of an inbound message from any Meta platform.
 */
export async function processMetaMessage(job: MetaMessageJob) {
  const { platform, identifier, senderId, messageText, externalId, msgType, mediaId, mediaMetadata } = job;

  // 1. Resolve Account/Profile
  let businessProfileId: number;
  let accessToken: string;
  let responseMode: "AUTO" | "MANUAL";
  let businessProfile: any;

  try {
    if (platform === "messenger") {
      const page = await prisma.facebookPage.findFirst({
        where: { pageId: identifier, isActive: true },
        include: { businessProfile: { include: { externalDataSources: { where: { isActive: true } }, crmIntegrations: { where: { isActive: true }, take: 1 } } } }
      });
      if (!page || !page.businessProfileId) throw new Error(`Messenger page ${identifier} not found or has no profile.`);
      businessProfileId = page.businessProfileId;
      businessProfile = page.businessProfile!;
      accessToken = decryptFacebookSecret(page.pageAccessToken);
      responseMode = page.businessProfile!.responseMode as any;
    } else {
      const account = await prisma.whatsAppAccount.findFirst({
        where: { phoneNumberId: identifier, isActive: true },
        include: { businessProfile: { include: { externalDataSources: { where: { isActive: true } }, crmIntegrations: { where: { isActive: true }, take: 1 } } } }
      });
      if (!account || !account.businessProfileId) throw new Error(`WhatsApp account ${identifier} not found or has no profile.`);
      businessProfileId = account.businessProfileId;
      businessProfile = account.businessProfile!;
      accessToken = decryptFacebookSecret(account.accessToken);
      responseMode = account.businessProfile!.responseMode as any;
    }
  } catch (err: any) {
    logger.error("meta.processor.identity_failed", { platform, identifier, error: err.message });
    return;
  }

  logger.info("meta.processor.started", { platform, businessProfileId, senderId, msgType: msgType || "text" });

  try {
    // 2. Resolve Customer Profile (with strict timeout for Messenger)
    let customerNameSet: string | undefined = job.customerName;
    let customerAvatarSet: string | undefined;

    if (platform === "messenger" && !customerNameSet) {
       // IDENTITY LOOKUP (Messenger specific)
       try {
         // Enforce 8s timeout to prevent queue hang
         const profilePromise = getFacebookUserProfile(senderId, identifier, accessToken);
         const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 8000));
         
         const profile: any = await Promise.race([profilePromise, timeoutPromise]);
         if (profile) {
           customerNameSet = profile.name;
           customerAvatarSet = profile.picture?.data?.url;
         }
       } catch (e: any) {
         logger.warn("meta.processor.profile_fetch_skipped", { senderId, reason: e.message });
         customerNameSet = "Guest Customer"; // Fallback to avoid hanging
       }
    }

    // 3. Sync Conversation
    const conversation = await getOrCreateConversation(identifier, senderId, businessProfileId, {
      channel: platform,
      customerName: customerNameSet,
      customerAvatar: customerAvatarSet,
      customerPhone: platform === "whatsapp" ? senderId : undefined,
    });

    // 4. Save User Message & Emit to UI
    const userSaved = await saveMessage(conversation.id, "user", messageText, {
      externalId,
      type: msgType || "text",
      mediaId,
      mediaMetadata,
    });

    emitToBusiness(businessProfileId, "new_message", { conversationId: conversation.id, message: userSaved });
    emitToConversation(conversation.id, "new_message", { message: userSaved });

    // 5. Manual Mode Guard
    if (responseMode === "MANUAL") {
      logger.info("meta.processor.manual_mode_hold", { conversationId: conversation.id });
      return;
    }

    // 6. Compute AI Reply
    const historyRows = await getConversationHistory(conversation.id);
    const historyTurns = historyToLlmTurns(toPromptMessages(historyRows));

    const reply = await computeBusinessChatReply({
      businessProfile,
      messageText,
      historyTurns,
      channel: platform,
      customerPhone: platform === "whatsapp" ? senderId : undefined,
      mediaInfo: mediaId ? { id: mediaId, type: msgType || "image" } : undefined,
    });

    if (reply.action === "RESOLVE_CONVERSATION") {
      await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "RESOLVED" } });
      return;
    }

    // 7. Save AI Choice (Draft or Sent)
    const isAutoMode = responseMode === "AUTO";
    const status = (reply.action === "HANDOFF_TO_HUMAN" || !isAutoMode) ? "PENDING_REVIEW" : "SENT";

    const modelSaved = await saveMessage(conversation.id, "model", reply.content || "", {
      status,
      aiReasoning: reply.reasoning,
      handoffCategory: reply.handoffCategory,
    });

    emitToBusiness(businessProfileId, "new_message", { conversationId: conversation.id, message: modelSaved });
    emitToConversation(conversation.id, "new_message", { message: modelSaved });

    if (status === "PENDING_REVIEW") {
       emitToBusiness(businessProfileId, "draft_received", { conversationId: conversation.id, message: modelSaved });
    }

    // 8. Platform Delivery (if AUTO)
    if (status === "SENT" && reply.content && reply.handoffCategory !== "SYSTEM_ERROR") {
      try {
        if (platform === "messenger") {
          const { sendMessengerReply } = await import("./messenger.service");
          const fbRes: any = await sendMessengerReply(senderId, reply.content, accessToken);
          if (fbRes?.message_id) await prisma.conversationMessage.update({ where: { id: modelSaved.id }, data: { externalId: fbRes.message_id } });
        } else {
          const { sendWhatsAppReply } = await import("./whatsapp.service");
          const waRes: any = await sendWhatsAppReply(senderId, reply.content, identifier, accessToken);
          const mid = waRes?.messages?.[0]?.id;
          if (mid) await prisma.conversationMessage.update({ where: { id: modelSaved.id }, data: { externalId: mid } });
        }
      } catch (sendErr: any) {
        logger.error("meta.processor.delivery_failed", { platform, error: sendErr.message });
      }
    }

    // 9. Feedback Loop
    if (reply.handoffCategory === "SYSTEM_ERROR") {
       emitToBusiness(businessProfileId, "system_critical_error", { conversationId: conversation.id, reason: reply.reasoning });
    }

  } catch (err: any) {
    logger.error("meta.processor.process_failed", { platform, identifier, senderId, error: err.message });
  }
}
