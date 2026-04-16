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
import { getFacebookUserProfile, getFacebookPostUrl } from "./facebook.service";

export type MetaPlatform = "messenger" | "whatsapp";

export interface MetaMessageJob {
  platform: MetaPlatform;
  identifier: string; // pageId for messenger, phoneNumberId for whatsapp
  senderId: string;   // customer PSID or phone number
  messageText: string;
  externalId?: string;
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
  const { platform, identifier, senderId, messageText, externalId, type, mediaId, mediaMetadata } = job;

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
      
      // Page-level mode overrides global profile mode
      responseMode = (page.responseMode || page.businessProfile!.responseMode) as any;
      
      // Store settings for later use in automation loops
      (job as any).pageSettings = {
        commentAutoDmEnabled: page.commentAutoDmEnabled,
        commentPublicGreeting: page.commentPublicGreeting
      };
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

  logger.info("meta.processor.started", { platform, businessProfileId, senderId, msgType: type || "text" });

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
    const finalType = type || "text";
    const finalContent = messageText || "";

    const userSaved = await saveMessage(conversation.id, "user", finalContent, {
      externalId,
      type: finalType,
      mediaId,
      mediaMetadata,
    });

    emitToBusiness(businessProfileId, "new_message", { conversationId: conversation.id, message: userSaved });
    emitToConversation(conversation.id, "new_message", { message: userSaved });

    // 5. Response Mode & AI Toggle Guards
    if (responseMode === "MANUAL") {
      logger.info("meta.processor.manual_mode_hold", { conversationId: conversation.id });
      return;
    }

    if (!(conversation as any).aiEnabled) {
      logger.info("meta.processor.ai_disabled_for_conversation", { conversationId: conversation.id });
      // If AI is disabled for this specific thread, we stop here. 
      // This allows sales agents to take 100% manual control.
      return;
    }

    // 6. Compute AI Reply
    const historyRows = await getConversationHistory(conversation.id);
    const historyTurns = historyToLlmTurns(toPromptMessages(historyRows));

    const isComment = !!job.commentId;
    
    // Inject Channel context so AI knows if it's on a public stage
    const contextualMessage = isComment 
      ? `[CHANNEL_CONTEXT: FACEBOOK_PUBLIC_COMMENT] ${finalContent}`
      : finalContent;

    const reply = await computeBusinessChatReply({
      businessProfile,
      messageText: contextualMessage,
      historyTurns,
      channel: isComment ? "facebook_comment" : platform as any,
      customerPhone: platform === "whatsapp" ? senderId : undefined,
      mediaInfo: mediaId ? { id: mediaId, type: type || "image", url: mediaMetadata?.url } : undefined,
    });

    if (reply.action === "RESOLVE_CONVERSATION") {
      await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "RESOLVED" } });
      return;
    }

    // 7. Save AI Choice (Draft or Sent)
    const isAutoMode = responseMode === "AUTO";
    const status = (reply.action === "HANDOFF_TO_HUMAN" || !isAutoMode) ? "PENDING_REVIEW" : "SENT";

    // Standard fallback logic for general chat
    const mainContent = reply.privateContent || reply.content || "";
    
    // If it's a comment, we might have dual content
    const pageSettings = (job as any).pageSettings; 

    // A. The "Core" Response (Usually the Private DM or standard reply)
    const modelSaved = await saveMessage(conversation.id, "model", mainContent, {
      status,
      aiReasoning: reply.reasoning,
      handoffCategory: isComment && reply.intent === "SALES_DM" ? "PRIVATE_DM_REPLY" : reply.handoffCategory,
      intent: reply.intent, // Persist detected intent
    });

    emitToBusiness(businessProfileId, "new_message", { conversationId: conversation.id, message: modelSaved });
    emitToConversation(conversation.id, "new_message", { message: modelSaved });

    // B. The "Public" Greeting (Only for comments)
    let publicSaved: any = null;
    if (isComment && (reply.publicContent || pageSettings?.commentPublicGreeting)) {
      const publicTxt = reply.publicContent || (pageSettings?.commentPublicGreeting || "Thanks {name}! Check your DMs.")
        .replace(/{name}|{{name}}/g, customerNameSet || "there");
        
      publicSaved = await saveMessage(conversation.id, "model", publicTxt, {
        status, // Should match main status
        handoffCategory: "PUBLIC_COMMENT_REPLY",
        intent: reply.intent, // Tag with same intent
      });
      
      emitToBusiness(businessProfileId, "new_message", { conversationId: conversation.id, message: publicSaved });
      emitToConversation(conversation.id, "new_message", { message: publicSaved });
    }

    // C. Resolve Post URL if missing (New Contextual Header requirement)
    if (isComment && job.postId && !conversation.postUrl) {
      try {
        const postUrl = await getFacebookPostUrl(job.postId, accessToken);
        if (postUrl) {
          await prisma.conversation.update({
            where: { id: conversation.id },
            data: { postUrl }
          });
          // Update local conversation object for subsequent emits if needed
          conversation.postUrl = postUrl;
        }
      } catch (err: any) {
        logger.warn("facebook.processor.post_url_resolve_failed", { error: err.message });
      }
    }

    if (status === "PENDING_REVIEW") {
       emitToBusiness(businessProfileId, "draft_received", { conversationId: conversation.id, message: modelSaved });
    }

    // 8. Platform Delivery (if AUTO)
    if (status === "SENT" && reply.handoffCategory !== "SYSTEM_ERROR") {
      try {
        if (platform === "messenger") {
          const { sendMessengerReply } = await import("./messenger.service");
          const { sendPrivateReply, replyToComment } = await import("./facebook.service");

          if (isComment) {
            // INTENT-AWARE DELIVERY
            const intent = reply.intent || "SALES_DM"; // Default to SALES_DM for backward compatibility
            
            if (intent === "IGNORE") {
              logger.info("meta.processor.ignore_intent", { commentId: job.commentId });
              return;
            }

            // 1. Sending Public Greeting (Contextual AI answer OR Template Fallback)
            const publicText = publicSaved?.content || "Thanks! Check your DMs.";
            // Humanized Jitter for public engagement
            const delay = 10000 + Math.random() * 20000; 
            setTimeout(async () => {
              try {
                await replyToComment({
                  commentId: job.commentId!,
                  message: publicText,
                  accessToken
                });
                logger.info("meta.processor.public_greeting_sent", { commentId: job.commentId });
              } catch (e: any) {
                logger.error("meta.processor.public_greeting_failed", { error: e.message });
              }
            }, delay);

            // 2. Sending Private DM ONLY if intent is SALES_DM
            if (intent === "SALES_DM" && mainContent) {
              const dmRes: any = await sendPrivateReply({ 
                commentId: job.commentId!, 
                message: mainContent, 
                accessToken 
              });
              
              if (dmRes?.id) {
                await prisma.conversationMessage.update({ 
                  where: { id: modelSaved.id }, 
                  data: { externalId: dmRes.id } 
                });
              }
              logger.info("meta.processor.private_dm_sent", { senderId, commentId: job.commentId });
            }

          } else if (mainContent) {
            // Standard Messenger Reply (Direct Message)
            const fbRes: any = await sendMessengerReply(senderId, mainContent, accessToken);
            if (fbRes?.message_id) await prisma.conversationMessage.update({ where: { id: modelSaved.id }, data: { externalId: fbRes.message_id } });
          }
        } else if (mainContent) {
          const { sendWhatsAppReply } = await import("./whatsapp.service");
          const waRes: any = await sendWhatsAppReply(senderId, mainContent, identifier, accessToken);
          const mid = waRes?.messages?.[0]?.id;
          if (mid) await prisma.conversationMessage.update({ where: { id: modelSaved.id }, data: { externalId: mid } });
        }

        // ── Attachment Delivery ────────────────────────────────────────────────
        if (reply.attachment?.assetName) {
          const { resolveAssetForChannel } = await import("../media/mediaLibrary.service");
          const resolved = await resolveAssetForChannel(reply.attachment.assetName, businessProfileId, platform);

          if (resolved) {
            if (platform === "whatsapp") {
              if (resolved.mediaId) {
                const { sendWhatsAppMedia } = await import("./whatsapp.service");
                await sendWhatsAppMedia(senderId, resolved.mediaId, resolved.mediaType, identifier, accessToken, reply.attachment.caption ?? undefined);
              } else if (resolved.url) {
                // Graceful fallback: send the public URL as a text message
                const { sendWhatsAppReply: sendWaText } = await import("./whatsapp.service");
                await sendWaText(senderId, `${reply.attachment.caption || "Here's the file"}: ${resolved.url}`, identifier, accessToken);
              }
            } else if (platform === "messenger" && resolved.mediaId) {
              const { sendMessengerMedia } = await import("./messenger.service");
              await sendMessengerMedia(senderId, resolved.mediaId, resolved.mediaType as any, accessToken);
            }
            // Save attachment as a distinct message bubble for inbox display
            await saveMessage(conversation.id, "model", reply.attachment.caption ?? "", {
              type: resolved.mediaType,
              mediaId: resolved.mediaId,
              status,
            });
          } else {
            logger.warn("meta.processor.attachment_not_found", { assetName: reply.attachment.assetName, businessProfileId });
          }
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
