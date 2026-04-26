import { UnrecoverableError } from "bullmq";
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
import {
  getFacebookUserProfile,
  likeComment,
} from "./facebook.service";

export type MetaPlatform = "messenger" | "whatsapp" | "visual_production" | "visual_refine" | "media_sync" | "facebook" | "instagram" | "linkedin";

export interface MetaMessageJob {
  platform: MetaPlatform;
  identifier: string;
  senderId: string;
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
  parentId?: string;
  senderName?: string;
  businessProfileId?: number;
  conversationId?: number;
  isPrivate?: boolean;
  
  // Status & Typing fields
  statusEvent?: "DELIVERED" | "READ";
  mids?: string[];
  watermark?: number;
  isTyping?: boolean;
}

interface IdentityResolution {
  businessProfileId: number;
  businessProfile: any;
  accessToken: string;
  responseMode: "AUTO" | "MANUAL";
  pageSettings: {
    commentAutoDmEnabled?: boolean;
    commentPublicGreeting?: string;
  } | null;
}

/**
 * Identity & Account Resolver
 */
async function resolveAccountIdentity(job: MetaMessageJob): Promise<IdentityResolution> {
  const { platform, identifier } = job;

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

    if (!page || !page.businessProfileId) {
      throw new UnrecoverableError(`Messenger page ${identifier} is not connected to a profile.`);
    }

    return {
      businessProfileId: page.businessProfileId,
      businessProfile: page.businessProfile,
      accessToken: decryptFacebookSecret(page.pageAccessToken),
      responseMode: (page.responseMode || page.businessProfile!.responseMode) as "AUTO" | "MANUAL",
      pageSettings: {
        commentAutoDmEnabled: page.commentAutoDmEnabled,
        commentPublicGreeting: page.commentPublicGreeting,
      },
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

    if (!account || !account.businessProfileId) {
      throw new UnrecoverableError(`WhatsApp account ${identifier} is not connected to a profile.`);
    }

    return {
      businessProfileId: account.businessProfileId,
      businessProfile: account.businessProfile,
      accessToken: decryptFacebookSecret(account.accessToken),
      responseMode: account.businessProfile!.responseMode as "AUTO" | "MANUAL",
      pageSettings: null,
    };
  }
}

/**
 * Customer Identity Resolver
 */
async function resolveCustomerProfile(job: MetaMessageJob, accessToken: string) {
  const { platform, senderId, identifier, senderName, customerName } = job;
  let name = customerName;
  let avatar: string | undefined;

  if (platform === "messenger" && !name) {
    try {
      const profilePromise = getFacebookUserProfile(senderId, identifier, accessToken);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 8000));
      const profile: any = await Promise.race([profilePromise, timeoutPromise]);

      if (profile?.name && String(profile.name).toLowerCase() !== "null") {
        name = profile.name;
        avatar = profile.picture?.data?.url;
      }
    } catch (e: any) {
      logger.warn("meta.processor.profile_fetch_skipped", { senderId, reason: e.message });
    }
  }

  return {
    name: name || senderName || "Guest Customer",
    avatar: avatar || undefined
  };
}

/**
 * High-Resilience Unified Meta Processor.
 */
export async function processMetaMessage(job: MetaMessageJob) {
  const { platform, identifier, senderId, messageText, externalId, type, mediaId, mediaMetadata } = job;

  try {
    // --- BACKGROUND EVENTS BRANCH ---
    if (type === "status_update") {
      const { statusEvent, mids, watermark } = job;
      if (platform === "whatsapp" && externalId && statusEvent) {
        await prisma.conversationMessage.updateMany({
          where: { externalId },
          data: { status: statusEvent }
        });
      } else if (platform === "messenger") {
        const conversation = await prisma.conversation.findFirst({
          where: { pageId: identifier, senderId, channel: "messenger" },
          select: { id: true, businessProfileId: true }
        });
        if (conversation) {
          if (statusEvent === "READ" && watermark) {
            await prisma.conversationMessage.updateMany({
              where: {
                conversationId: conversation.id,
                role: "model",
                status: { not: "READ" },
                createdAt: { lte: new Date(watermark) }
              },
              data: { status: "READ" }
            });
            const { syncBulkMessageStatus } = await import("../socketSync.service");
            syncBulkMessageStatus({
              businessProfileId: conversation.businessProfileId,
              conversationId: conversation.id,
              status: "READ",
              metadata: { watermark }
            });
          } else if (statusEvent === "DELIVERED" && mids?.length) {
            await prisma.conversationMessage.updateMany({
              where: { externalId: { in: mids } },
              data: { status: "DELIVERED" }
            });
          }
        }
      }
      return;
    }

    if (type === "typing_indicator") {
      const conversation = await prisma.conversation.findFirst({
        where: { pageId: identifier, senderId, channel: "messenger" },
        select: { id: true, businessProfileId: true }
      });
      if (conversation) {
        const { syncTypingStatus } = await import("../socketSync.service");
        syncTypingStatus({
          businessProfileId: conversation.businessProfileId,
          conversationId: conversation.id,
          isTyping: job.isTyping ?? false
        });
      }
      return;
    }
    // --- END BACKGROUND EVENTS BRANCH ---

    // 1. Resolve Identity
    const { businessProfileId, businessProfile, accessToken, responseMode, pageSettings } = await resolveAccountIdentity(job);

    // 2. Idempotency Check
    if (externalId) {
      const { isDuplicateWebhook } = await import("./webhookCache.service");
      if (await isDuplicateWebhook(externalId)) return;

      const existing = await prisma.conversationMessage.findFirst({ where: { externalId }, select: { id: true } });
      if (existing) return;
    }

    // 3. Early Returns
    if (type === "FACEBOOK_COMMENT_PUBLIC_REPLY") {
      const { replyToComment } = await import("./facebook.service");
      await replyToComment({ commentId: job.commentId!, message: messageText, accessToken, pageId: identifier, businessProfileId });
      return;
    }

    // 4. Resolve Context & Sync
    const { name: customerName, avatar: customerAvatar } = await resolveCustomerProfile(job, accessToken);
    const isComment = !!job.commentId;
    
    const conversation = await getOrCreateConversation(identifier, senderId, businessProfileId, {
      channel: isComment ? "facebook_comment" : platform,
      customerName,
      customerAvatar,
      customerPhone: platform === "whatsapp" ? senderId : undefined,
      externalId: job.commentId,
      postId: job.postId,
      sourceCommentText: isComment ? messageText : undefined,
    });

    const userSaved = await saveMessage(conversation.id, "user", messageText || "", {
      externalId,
      type: type || "text",
      mediaId,
      mediaMetadata,
      isPrivate: platform === "messenger" ? true : (job.isPrivate ?? false),
    });

    if (responseMode === "MANUAL" || !(conversation as any).aiEnabled) return;

    // 5. AI Reply Generation
    const historyRows = await getConversationHistory(conversation.id, userSaved.createdAt, job.postId);
    const historyTurns = historyToLlmTurns(toPromptMessages(historyRows));

    let postContext: any;
    if (isComment && job.postId) {
      const { getPostContext, getCommentText } = await import("./facebook.service");
      const [pContext, parContext] = await Promise.all([
        getPostContext(job.postId, accessToken),
        job.parentId ? getCommentText(job.parentId, accessToken) : Promise.resolve(null)
      ]);
      if (pContext) postContext = { content: pContext.content, media: pContext.media, parentContext: parContext || undefined };
    }

    const { syncTypingStatus } = await import("../socketSync.service");
    syncTypingStatus({ businessProfileId, conversationId: conversation.id, isTyping: true });

    const reply = await computeBusinessChatReply({
      businessProfile,
      messageText: messageText || "",
      historyTurns,
      channel: isComment ? "facebook_comment" : (platform as any),
      customerPhone: platform === "whatsapp" ? senderId : undefined,
      mediaInfo: mediaId ? { id: mediaId, type: type || "image", url: mediaMetadata?.url } : undefined,
      postContext,
      conversationId: conversation.id,
    });

    syncTypingStatus({ businessProfileId, conversationId: conversation.id, isTyping: false });

    if (reply.action === "RESOLVE_CONVERSATION") {
      await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "RESOLVED" } });
      return;
    }

    // 6. Delivery Orchestration
    const isAutoMode = responseMode === "AUTO";
    const privateStatus = (isAutoMode && reply.action !== "HANDOFF_TO_HUMAN") ? "SENT" : "PENDING_REVIEW";
    const publicStatus = isAutoMode ? "SENT" : "PENDING_REVIEW";
    const mainContent = (reply.privateContent || reply.content || "").trim();

    // A. Save Model Messages
    let modelSaved: any;
    if (mainContent.length > 0 || reply.action === "HANDOFF_TO_HUMAN") {
      modelSaved = await saveMessage(conversation.id, "model", mainContent, {
        status: privateStatus,
        aiReasoning: reply.reasoning,
        handoffCategory: (isComment && reply.intent === "SALES_DM") ? "PRIVATE_DM_REPLY" : reply.handoffCategory,
        intent: reply.intent,
        isPrivate: platform === "messenger" ? true : (isComment && reply.intent === "SALES_DM"),
        origin: isComment ? "facebook_comment_reply" : undefined,
      });
    }

    let publicSaved: any;
    if (isComment && (reply.publicContent || pageSettings?.commentPublicGreeting)) {
      const publicTxt = (reply.publicContent || pageSettings?.commentPublicGreeting || "Thanks {name}!").replace(/{name}/g, customerName).trim();
      if (publicTxt.length > 0) {
        publicSaved = await saveMessage(conversation.id, "model", publicTxt, {
          status: publicStatus,
          handoffCategory: "PUBLIC_COMMENT_REPLY",
          intent: reply.intent,
          isPrivate: false,
          origin: "facebook_comment_public_reply",
        });
      }
    }

    // B. Platform Delivery
    if (isAutoMode && reply.handoffCategory !== "SYSTEM_ERROR") {
      const { mirrorCommentReplyToMessenger, syncMessageStatus } = await import("./metaDelivery.service");

      if (platform === "messenger") {
        const { sendPrivateReply, replyToComment } = await import("./facebook.service");
        
        if (isComment) {
          if (reply.intent === "IGNORE") return;

          likeComment({ commentId: job.commentId!, accessToken, pageId: identifier }).catch(() => {});

          if (publicStatus === "SENT" && publicSaved) {
            await replyToComment({ commentId: job.commentId!, message: publicSaved.content, accessToken, pageId: identifier, businessProfileId })
              .then(res => res && syncMessageStatus(publicSaved.id, businessProfileId, conversation.id, { externalId: res.id }))
              .catch(() => syncMessageStatus(publicSaved.id, businessProfileId, conversation.id, { status: "FAILED" }));
          }

          if (privateStatus === "SENT" && modelSaved) {
            if (reply.intent === "SALES_DM") {
              await sendPrivateReply({ commentId: job.commentId!, message: mainContent, accessToken, pageId: identifier, businessProfileId })
                .then(async res => {
                  if (res?.id && res.id !== "ALREADY_REPLIED") {
                    await syncMessageStatus(modelSaved.id, businessProfileId, conversation.id, { externalId: res.id });
                    await mirrorCommentReplyToMessenger({ pageId: identifier, senderId, businessProfileId, messageId: res.id, content: mainContent, intent: reply.intent, reasoning: reply.reasoning, postId: job.postId, commentId: job.commentId, role: "model" });
                  }
                })
                .catch(() => syncMessageStatus(modelSaved.id, businessProfileId, conversation.id, { status: "FAILED" }));
            } else {
              await replyToComment({ commentId: job.commentId!, message: mainContent, accessToken, pageId: identifier, businessProfileId })
                .then(res => res && syncMessageStatus(modelSaved.id, businessProfileId, conversation.id, { externalId: res.id }))
                .catch(() => syncMessageStatus(modelSaved.id, businessProfileId, conversation.id, { status: "FAILED" }));
            }
          }
        } else if (modelSaved && privateStatus === "SENT") {
          const { sendMessengerReply } = await import("./messenger.service");
          await sendMessengerReply(senderId, mainContent, accessToken)
            .then(res => res?.message_id && syncMessageStatus(modelSaved.id, businessProfileId, conversation.id, { externalId: res.message_id }))
            .catch(() => syncMessageStatus(modelSaved.id, businessProfileId, conversation.id, { status: "FAILED" }));
        }
      } else if (platform === "whatsapp" && modelSaved && privateStatus === "SENT") {
        const { sendWhatsAppReply } = await import("./whatsapp.service");
        await sendWhatsAppReply(senderId, mainContent, identifier, accessToken)
          .then(res => res?.messages?.[0]?.id && prisma.conversationMessage.update({ where: { id: modelSaved.id }, data: { externalId: res.messages[0].id } }));
      }
    }
  } catch (err: any) {
    if (err instanceof UnrecoverableError) throw err;
    logger.error("meta.processor.failure", { platform, identifier, error: err.message });
    throw err;
  }
}

/**
 * PRODUCTION-GRADE: Background Visual Processor
 */
export async function processVisualJob(payload: any) {
  const { type, businessProfileId, userId, prompt, instruction, assetId, postId, senderId, messageText, mediaId } = payload;
  const normalizedType = type === "visual_production" ? "generate" : (type === "visual_refine" ? "refine" : type);
  const normalizedUserId = Number(userId || senderId);
  const normalizedPrompt = prompt || messageText;
  const normalizedInstruction = instruction || messageText;
  const normalizedAssetId = Number(assetId || mediaId);

  try {
    const { createGeminiVisual, refineGeminiVisual } = await import("../media/geminiVisual.service");
    let resultAsset;
    if (normalizedType === "generate") {
      resultAsset = await createGeminiVisual({
        businessProfileId,
        userId: normalizedUserId,
        userPrompt: normalizedPrompt,
        postId,
      });
    } else {
      resultAsset = await refineGeminiVisual({
        businessProfileId,
        userId: normalizedUserId,
        assetId: normalizedAssetId,
        instruction: normalizedInstruction,
        postId,
      });
    }
    logger.info("visual_processor.complete", { assetId: resultAsset.id });
  } catch (err: any) {
    logger.error("visual_processor.failed", { error: err.message });
    throw err;
  }
}
