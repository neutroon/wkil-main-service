import prisma from "../../config/prisma";
import { logger } from "../../utils/logger";
import { emitToBusiness, emitToConversation } from "../../utils/socket";
import { decryptFacebookSecret } from "../../utils/tokenCrypto";
import {
  getOrCreateConversation,
  getConversationHistory,
  saveMessage,
} from "./conversation.service";
import { computeBusinessChatReply } from "../chat/businessChatReply.service";
import { historyToLlmTurns, toPromptMessages } from "../chat/conversationTurns";
// No change to socket imports here as they are now at top
import {
  getFacebookUserProfile,
  getFacebookPostUrl,
  getPostContext,
  getCommentText,
  likeComment,
} from "./facebook.service";

export type MetaPlatform = "messenger" | "whatsapp";

export interface MetaMessageJob {
  platform: MetaPlatform;
  identifier: string; // pageId for messenger, phoneNumberId for whatsapp
  senderId: string; // customer PSID or phone number
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
  parentId?: string; // NEW: Track parent comment for deep context
  senderName?: string;
  businessProfileId?: number;
  conversationId?: number;
}

// ELITE TIER: Spam & Burst Shield
// Prevents AI loops or user spam from draining API credits.
const SPAM_GUARD_CACHE = new Map<string, { count: number; lastMessageAt: number }>();
const SPAM_LIMIT = 3; // Max 3 messages per cooldown
const SPAM_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * High-Resilience Unified Meta Processor.
 * Handles the end-to-end lifecycle of an inbound message from any Meta platform.
 */
export async function processMetaMessage(job: MetaMessageJob) {
  const {
    platform,
    identifier,
    senderId,
    messageText,
    externalId,
    type,
    mediaId,
    mediaMetadata,
  } = job;

  // 1. Resolve Account/Profile
  let businessProfileId: number;
  let accessToken: string;
  let responseMode: "AUTO" | "MANUAL";
  let businessProfile: any;

  try {
    if (platform === "messenger") {
      const page = await prisma.facebookPage.findFirst({
        where: { pageId: identifier, isActive: true },
        include: {
          businessProfile: {
            include: {
              externalDataSources: { where: { isActive: true } },
              crmIntegrations: { where: { isActive: true }, take: 1 },
            },
          },
        },
      });
      if (!page || !page.businessProfileId)
        throw new Error(
          `Messenger page ${identifier} not found or has no profile.`,
        );
      businessProfileId = page.businessProfileId;
      businessProfile = page.businessProfile!;
      accessToken = decryptFacebookSecret(page.pageAccessToken);

      // Page-level mode overrides global profile mode
      responseMode = (page.responseMode ||
        page.businessProfile!.responseMode) as any;

      // Store settings for later use in automation loops
      (job as any).pageSettings = {
        commentAutoDmEnabled: page.commentAutoDmEnabled,
        commentPublicGreeting: page.commentPublicGreeting,
      };
    } else {
      const account = await prisma.whatsAppAccount.findFirst({
        where: { phoneNumberId: identifier, isActive: true },
        include: {
          businessProfile: {
            include: {
              externalDataSources: { where: { isActive: true } },
              crmIntegrations: { where: { isActive: true }, take: 1 },
            },
          },
        },
      });
      if (!account || !account.businessProfileId)
        throw new Error(
          `WhatsApp account ${identifier} not found or has no profile.`,
        );
      businessProfileId = account.businessProfileId;
      businessProfile = account.businessProfile!;
      accessToken = decryptFacebookSecret(account.accessToken);
      responseMode = account.businessProfile!.responseMode as any;
    }
  } catch (err: any) {
    logger.error("meta.processor.identity_failed", {
      platform,
      identifier,
      error: err.message,
    });
    return;
  }

  logger.info("meta.processor.started", {
    platform,
    businessProfileId,
    senderId,
    msgType: type || "text",
    externalId,
  });

  // 1b. ELITE TIER: Spam Shield (Burst Protection)
  const spamKey = `${businessProfileId}_${senderId}`;
  const now = Date.now();
  const userData = SPAM_GUARD_CACHE.get(spamKey);

  if (userData) {
    // If within cooldown period
    if (now - userData.lastMessageAt < SPAM_COOLDOWN_MS) {
      if (userData.count >= SPAM_LIMIT) {
        logger.warn("meta.processor.spam_shield_activated", { senderId, businessProfileId });
        return; // Ignore silently
      }
      userData.count += 1;
      userData.lastMessageAt = now;
    } else {
      // Cooldown expired, reset
      SPAM_GUARD_CACHE.set(spamKey, { count: 1, lastMessageAt: now });
    }
  } else {
    // First message from this user
    SPAM_GUARD_CACHE.set(spamKey, { count: 1, lastMessageAt: now });
  }

  // 1b. IDEMPOTENCY GUARD: Prevent duplicate processing of the same message/comment
  if (externalId) {
    const existing = await prisma.conversationMessage.findFirst({
      where: { externalId },
      select: { id: true },
    });
    if (existing) {
      logger.warn("meta.processor.duplicate_event_detected", {
        externalId,
        platform,
      });
      return;
    }
  }
  // If this is a scheduled public reply, we skip AI/Conversation logic and go straight to delivery.
  if (type === "FACEBOOK_COMMENT_PUBLIC_REPLY") {
    try {
      const { replyToComment } = await import("./facebook.service");
      await replyToComment({
        commentId: job.commentId!,
        message: messageText,
        accessToken,
        pageId: identifier,
        businessProfileId,
      });
      logger.info("meta.processor.public_greeting_delivered", {
        commentId: job.commentId,
      });
      return;
    } catch (err: any) {
      logger.error("meta.processor.public_greeting_failed", {
        commentId: job.commentId,
        error: err.message,
      });

      // UI SIGNAL: Notify the dashboard that the public greeting FAILED
      if (job.businessProfileId) {
        emitToBusiness(job.businessProfileId, "job_failed", {
          conversationId: job.conversationId,
          type: "FACEBOOK_COMMENT_PUBLIC_REPLY",
          error: err.message,
        });
      }

      throw err; // Re-throw to allow queue retry
    }
  }

  try {
    // 2. Resolve Customer Profile (with strict timeout for Messenger)
    let customerNameSet: string | undefined = job.customerName;
    let customerAvatarSet: string | undefined;

    if (platform === "messenger" && !customerNameSet) {
      // IDENTITY LOOKUP (Messenger specific)
      try {
        // Enforce 8s timeout to prevent queue hang
        const profilePromise = getFacebookUserProfile(
          senderId,
          identifier,
          accessToken,
        );
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 8000),
        );

        const profile: any = await Promise.race([
          profilePromise,
          timeoutPromise,
        ]);

        // Production Guard: Validate name is present and not the literal string "null"
        if (
          profile &&
          profile.name &&
          String(profile.name).toLowerCase() !== "null"
        ) {
          customerNameSet = profile.name;
          customerAvatarSet = profile.picture?.data?.url;
        } else if (job.senderName) {
          customerNameSet = job.senderName;
        }
      } catch (e: any) {
        logger.warn("meta.processor.profile_fetch_skipped", {
          senderId,
          reason: e.message,
        });
        customerNameSet = job.senderName || "Guest Customer"; // Fallback to avoid hanging
      } finally {
        // Double-check for absolute safety
        if (
          !customerNameSet ||
          String(customerNameSet).toLowerCase() === "null"
        ) {
          customerNameSet = job.senderName || "Guest Customer";
        }
      }
    }

    // 3. Sync Conversation
    const isComment = !!job.commentId;
    const conversation = await getOrCreateConversation(
      identifier,
      senderId,
      businessProfileId,
      {
        channel: isComment ? "facebook_comment" : platform,
        customerName: customerNameSet,
        customerAvatar: customerAvatarSet,
        customerPhone: platform === "whatsapp" ? senderId : undefined,
        externalId: job.commentId,
        postId: (job as any).postId,
        sourceCommentText: isComment ? messageText : undefined,
      },
    );

    // 4. Save User Message & Emit to UI
    const finalType = type || "text";
    const finalContent = messageText || "";

    const userSaved = await saveMessage(conversation.id, "user", finalContent, {
      externalId,
      type: finalType,
      mediaId,
      mediaMetadata,
    });

    emitToBusiness(businessProfileId, "new_message", {
      conversationId: conversation.id,
      message: userSaved,
    });
    emitToConversation(conversation.id, "new_message", { message: userSaved });

    // 5. Response Mode & AI Toggle Guards
    if (responseMode === "MANUAL") {
      logger.info("meta.processor.manual_mode_hold", {
        conversationId: conversation.id,
      });
      return;
    }

    if (!(conversation as any).aiEnabled) {
      logger.info("meta.processor.ai_disabled_for_conversation", {
        conversationId: conversation.id,
      });
      // If AI is disabled for this specific thread, we stop here.
      // This allows sales agents to take 100% manual control.
      return;
    }

    // 6. Compute AI Reply
    const historyRows = await getConversationHistory(
      conversation.id,
      userSaved.createdAt,
      job.postId,
    );
    const historyTurns = historyToLlmTurns(toPromptMessages(historyRows));

    // ELITE TIER: Fetch deep context (Post Text + Media) for Facebook Comments
    // We pass this as structured data for the System Prompt, not as a message prefix.
    let postContext: { content: string; media?: string; parentContext?: string } | undefined;

    if (isComment) {
      const postId = (job as any).postId;
      const parentId = job.parentId;

      const promises: Promise<any>[] = [];
      if (postId) promises.push(getPostContext(postId, accessToken));
      if (parentId) promises.push(getCommentText(parentId, accessToken));

      const [pContext, parContext] = await Promise.all(promises);
      
      if (pContext) {
        postContext = { 
          content: pContext.content, 
          media: pContext.media,
          parentContext: parContext || undefined 
        };
      }
    }

    // Emit "AI Typing" for better UX
    emitToBusiness(businessProfileId, "customer_typing", { 
      conversationId: conversation.id, 
      typing: true 
    });

    const reply = await computeBusinessChatReply({
      businessProfile,
      messageText: finalContent,
      historyTurns,
      channel: isComment ? "facebook_comment" : (platform as any),
      customerPhone: platform === "whatsapp" ? senderId : undefined,
      mediaInfo: mediaId
        ? { id: mediaId, type: type || "image", url: mediaMetadata?.url }
        : undefined,
      postContext,
    });

    emitToBusiness(businessProfileId, "customer_typing", { 
      conversationId: conversation.id, 
      typing: false 
    });

    if (reply.action === "RESOLVE_CONVERSATION") {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: "RESOLVED" },
      });
      return;
    }

    // 7. Save AI Choice (Draft or Sent)
    const isAutoMode = responseMode === "AUTO";
    const status =
      reply.action === "HANDOFF_TO_HUMAN" || !isAutoMode
        ? "PENDING_REVIEW"
        : "SENT";

    // Standard fallback logic for general chat
    const mainContent = (reply.privateContent || reply.content || "").trim();

    // If it's a comment, we might have dual content settings
    const pageSettings = (job as any).pageSettings;

    // A. The "Core" Response (Usually the Private DM or standard reply)
    let modelSaved: any = null;
    if (mainContent.length > 0 || reply.action === "HANDOFF_TO_HUMAN") {
      modelSaved = await saveMessage(conversation.id, "model", mainContent, {
        status,
        aiReasoning: reply.reasoning,
        handoffCategory:
          isComment && reply.intent === "SALES_DM"
            ? "PRIVATE_DM_REPLY"
            : reply.handoffCategory,
        intent: reply.intent, // Persist detected intent
        isPrivate: isComment && reply.intent === "SALES_DM",
        origin: isComment ? "facebook_comment_reply" : undefined,
      });

      emitToBusiness(businessProfileId, "new_message", {
        conversationId: conversation.id,
        message: modelSaved,
      });
      emitToConversation(conversation.id, "new_message", {
        message: modelSaved,
      });
    } else {
      logger.info("meta.processor.empty_main_content_skipped", {
        conversationId: conversation.id,
        intent: reply.intent,
        reasoning: reply.reasoning,
      });
    }

    // B. The "Public" Greeting (Only for comments)
    let publicSaved: any = null;
    if (
      isComment &&
      (reply.publicContent || pageSettings?.commentPublicGreeting)
    ) {
      const publicTxt = (
        reply.publicContent ||
        pageSettings?.commentPublicGreeting ||
        "Thanks {name}! Check your DMs."
      )
        .replace(/{name}|{{name}}/g, customerNameSet || "there")
        .trim();

      if (publicTxt.length > 0) {
        publicSaved = await saveMessage(conversation.id, "model", publicTxt, {
          status, // Should match main status
          handoffCategory: "PUBLIC_COMMENT_REPLY",
          intent: reply.intent, // Tag with same intent
          isPrivate: false,
          origin: "facebook_comment_public_reply",
        });

        emitToBusiness(businessProfileId, "new_message", {
          conversationId: conversation.id,
          message: publicSaved,
        });
        emitToConversation(conversation.id, "new_message", {
          message: publicSaved,
        });
      } else {
        logger.info("meta.processor.empty_public_content_skipped", {
          conversationId: conversation.id,
        });
      }
    }

    // C. Resolve Post URL if missing (New Contextual Header requirement)
    if (isComment && job.postId && !conversation.postUrl) {
      try {
        const postUrl = await getFacebookPostUrl(job.postId, accessToken);
        if (postUrl) {
          await prisma.conversation.update({
            where: { id: conversation.id },
            data: { postUrl },
          });
          // Update local conversation object for subsequent emits if needed
          conversation.postUrl = postUrl;

          // Emit sync to UI
          emitToBusiness(businessProfileId, "conversation_updated", {
            id: conversation.id,
            postUrl,
          });
        }
      } catch (err: any) {
        logger.warn("facebook.processor.post_url_resolve_failed", {
          error: err.message,
        });
      }
    }

    if (status === "PENDING_REVIEW") {
      emitToBusiness(businessProfileId, "draft_received", {
        conversationId: conversation.id,
        message: modelSaved,
      });
    }

    // 8. Platform Delivery (if AUTO)
    if (status === "SENT" && reply.handoffCategory !== "SYSTEM_ERROR") {
      try {
        if (platform === "messenger") {
          const { sendMessengerReply } = await import("./messenger.service");
          const { sendPrivateReply, replyToComment } =
            await import("./facebook.service");

          if (isComment) {
            // INTENT-AWARE DELIVERY
            const intent = reply.intent || "SALES_DM";

            if (intent === "IGNORE") {
              logger.info("meta.processor.ignore_intent", {
                commentId: job.commentId,
              });
              return;
            }

            // 1. SCHEDULE Durable Public Greeting (Durable Jitter)
            // Human-like response simulation (20 to 45 seconds) to avoid robotic instant replies
            const publicText = publicSaved?.content || "Thanks! Check your DMs.";
            const delaySec = 20 + Math.floor(Math.random() * 25);
            const nextAttemptAt = new Date(Date.now() + delaySec * 1000);

            await prisma.metaJob.create({
              data: {
                platform: "messenger",
                identifier: job.identifier,
                senderId: job.senderId,
                status: "pending",
                nextAttemptAt,
                payload: {
                  ...job,
                  type: "FACEBOOK_COMMENT_PUBLIC_REPLY",
                  messageText: publicText,
                  businessProfileId,
                  conversationId: conversation.id,
                } as any,
              },
            });
            logger.info("meta.processor.public_greeting_scheduled", {
              commentId: job.commentId,
              delaySec,
            });

            // UI SIGNAL: Notify the dashboard that a public greeting is scheduled
            emitToBusiness(businessProfileId, "job_scheduled", {
              conversationId: conversation.id,
              type: "FACEBOOK_COMMENT_PUBLIC_REPLY",
              nextAttemptAt,
            });

            // 2. Sending Private DM ONLY if intent is SALES_DM AND the setting is enabled for this page
            const isAutoDmAllowed = pageSettings?.commentAutoDmEnabled === true;

            if (intent === "SALES_DM" && mainContent && isAutoDmAllowed) {
              const dmRes: any = await sendPrivateReply({
                commentId: job.commentId!,
                message: mainContent,
                accessToken,
                pageId: job.identifier,
                businessProfileId, // ELITE TOKEN PIVOTING
              });

              if (dmRes?.id && dmRes.id !== "ALREADY_REPLIED") {
                await prisma.conversationMessage.update({
                  where: { id: modelSaved.id },
                  data: { externalId: dmRes.id },
                });
                logger.info("meta.processor.private_dm_sent", {
                  senderId,
                  commentId: job.commentId,
                  messageId: dmRes.id
                });

                // ── ELITE TIER: Selective Mirroring ( Inbox Continuity ) ──
                // We mirror only the Private Reply to the main Messenger thread for Image 2 continuity.
                try {
                  const messengerConv = await getOrCreateConversation(
                    job.identifier,
                    senderId,
                    businessProfileId,
                    { channel: "messenger" }
                  );

                  // Only mirror if it doesn't already exist in the Messenger thread
                  const existingMirror = await prisma.conversationMessage.findUnique({
                    where: { externalId: dmRes.id }
                  });

                  if (!existingMirror) {
                    await saveMessage(messengerConv.id, "model", mainContent, {
                      externalId: dmRes.id,
                      intent: reply.intent,
                      aiReasoning: reply.reasoning,
                      isPrivate: true,
                      origin: "facebook_comment_reply",
                      mediaMetadata: { 
                        origin: "facebook_comment_reply", 
                        postId: job.postId,
                        commentId: job.commentId
                      }
                    });
                    logger.info("meta.processor.private_mirror_created", {
                      messengerConvId: messengerConv.id,
                      messageId: dmRes.id
                    });
                  }
                } catch (mirrorErr: any) {
                  logger.warn("meta.processor.mirror_failed_soft", { error: mirrorErr.message });
                }

                // ELITE TIER: Engagement - Like the comment after successful reply
                likeComment({
                  commentId: job.commentId!,
                  accessToken,
                  pageId: job.identifier
                }).catch(err => logger.warn("meta.processor.auto_like_failed", { error: err.message }));

              } else if (dmRes?.id === "ALREADY_REPLIED") {
                logger.info("meta.processor.private_dm_skipped_already_sent", {
                  commentId: job.commentId
                });
              } else {
                logger.warn("meta.processor.private_dm_delivery_status_ambiguous", {
                  commentId: job.commentId
                });
              }
            }
          } else if (mainContent) {
            // Standard Messenger Reply (Direct Message)
            const fbRes: any = await sendMessengerReply(
              senderId,
              mainContent,
              accessToken,
            );
            if (fbRes?.message_id)
              await prisma.conversationMessage.update({
                where: { id: modelSaved.id },
                data: { externalId: fbRes.message_id },
              });
          }
        } else if (mainContent) {
          const { sendWhatsAppReply } = await import("./whatsapp.service");
          const waRes: any = await sendWhatsAppReply(
            senderId,
            mainContent,
            identifier,
            accessToken,
          );
          const mid = waRes?.messages?.[0]?.id;
          if (mid)
            await prisma.conversationMessage.update({
              where: { id: modelSaved.id },
              data: { externalId: mid },
            });
        }

        // ── Attachment Delivery ────────────────────────────────────────────────
        if (reply.attachment?.assetName) {
          const { resolveAssetForChannel } =
            await import("../media/mediaLibrary.service");
          const resolved = await resolveAssetForChannel(
            reply.attachment.assetName,
            businessProfileId,
            platform,
            identifier,
          );

          if (resolved) {
            if (platform === "whatsapp") {
              if (resolved.mediaId) {
                const { sendWhatsAppMedia } =
                  await import("./whatsapp.service");
                await sendWhatsAppMedia(
                  senderId,
                  resolved.mediaId,
                  resolved.mediaType,
                  identifier,
                  accessToken,
                  reply.attachment.caption ?? undefined,
                );
              } else if (resolved.url) {
                // Graceful fallback: send the public URL as a text message
                const { sendWhatsAppReply: sendWaText } =
                  await import("./whatsapp.service");
                await sendWaText(
                  senderId,
                  `${reply.attachment.caption || "Here's the file"}: ${resolved.url}`,
                  identifier,
                  accessToken,
                );
              }
            } else if (platform === "messenger" && resolved.mediaId) {
              const { sendMessengerMedia } =
                await import("./messenger.service");
              await sendMessengerMedia(
                senderId,
                resolved.mediaId,
                resolved.mediaType as any,
                accessToken,
              );
            }
            // Save attachment as a distinct message bubble for inbox display
            await saveMessage(
              conversation.id,
              "model",
              reply.attachment.caption ?? "",
              {
                type: resolved.mediaType,
                mediaId: resolved.mediaId,
                status,
              },
            );
          } else {
            logger.warn("meta.processor.attachment_not_found", {
              assetName: reply.attachment.assetName,
              businessProfileId,
            });
          }
        }
      } catch (sendErr: any) {
        logger.error("meta.processor.delivery_failed", {
          platform,
          error: sendErr.message,
        });
      }
    }

    // 9. Feedback Loop
    if (reply.handoffCategory === "SYSTEM_ERROR") {
      emitToBusiness(businessProfileId, "system_critical_error", {
        conversationId: conversation.id,
        reason: reply.reasoning,
      });
    }
  } catch (err: any) {
    logger.error("meta.processor.process_failed", {
      platform,
      identifier,
      senderId,
      error: err.message,
    });
  }
}

/**
 * PRODUCTION-GRADE: Background Visual Processor
 * Executed by the MetaQueue worker to handle heavy AI image generation/refinement.
 */
export async function processVisualJob(payload: any) {
  const { type, businessProfileId, userId, prompt, instruction, assetId, postId } = payload;

  logger.info("visual_processor.job_picked", { type, businessProfileId, userId, postId });

  try {
    const { createGeminiVisual, refineGeminiVisual } = await import("../media/geminiVisual.service");

    let resultAsset;
    if (type === "generate") {
      resultAsset = await createGeminiVisual({
        userId,
        businessProfileId,
        userPrompt: prompt,
        postId,
      });
    } else if (type === "refine") {
      resultAsset = await refineGeminiVisual({
        userId,
        businessProfileId,
        assetId,
        instruction,
        postId,
      });
    }

    // Push real-time update to the dashboard
    emitToBusiness(businessProfileId, "visual_updated", {
      type,
      postId,
      asset: resultAsset,
      status: "completed"
    });

    logger.info("visual_processor.job_completed", { type, businessProfileId, assetId: resultAsset?.id });

  } catch (err: any) {
    logger.error("visual_processor.job_failed", { type, businessProfileId, error: err.message });
    
    // Notify UI of failure so it can stop the loader
    emitToBusiness(businessProfileId, "visual_updated", {
      type,
      postId,
      status: "failed",
      error: err.message
    });

    throw err; // Re-throw for queue retry logic
  }
}
