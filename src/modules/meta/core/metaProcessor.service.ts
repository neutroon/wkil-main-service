import { UnrecoverableError } from "bullmq";
import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { cache } from "@utils/cache";
import {
  getOrCreateConversation,
  getConversationHistory,
  saveMessage,
} from "../core/conversation.service";
import { computeBusinessChatReply } from "@modules/ai-agent/chat/businessChatReply.service";
import { historyToLlmTurns, toPromptMessages } from "@modules/ai-agent/chat/conversationTurns";
import {
  getFacebookUserProfile,
  likeComment,
} from "../facebook/facebook.service";

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
  isFromBusiness?: boolean;
  
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

/** Cached identity payload — accessToken is intentionally excluded (fetched fresh from DB) */
type CachedIdentity = Omit<IdentityResolution, "accessToken">;

const IDENTITY_CACHE_TTL = 900; // 15 minutes

/**
 * Identity & Account Resolver — with 15-minute Redis cache.
 *
 * Strategy:
 * - The heavy JOIN query result (businessProfile + externalDataSources + crmIntegrations)
 *   is cached for 15 minutes to protect the DB on high-volume webhook spikes.
 * - The accessToken is NEVER cached in Redis. On a cache hit, we do a fast single-field
 *   indexed lookup (pageId/phoneNumberId) to get the fresh token.
 * - Cache is invalidated on every: connect, disconnect, link, unlink, settings change.
 */
async function resolveAccountIdentity(job: MetaMessageJob): Promise<IdentityResolution> {
  const { platform, identifier } = job;
  const cacheKey = `identity:${platform}:${identifier}`;

  // 1. Try cache (non-sensitive data only)
  const cachedRaw = await cache.get<string>(cacheKey);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw) as CachedIdentity;
      logger.debug("meta.processor.identity_cache_hit", { platform, identifier });

      // Fetch ONLY the token — fast indexed single-field query
      const tokenRow = platform === "messenger"
        ? await prisma.facebookPage.findFirst({
            where: { pageId: identifier, isActive: true },
            select: { pageAccessToken: true, isTokenValid: true }
          })
        : await prisma.whatsAppAccount.findFirst({
            where: { phoneNumberId: identifier, isActive: true },
            select: { accessToken: true, isTokenValid: true }
          });

      if (!tokenRow) {
        // Cache is stale — page was disconnected. Invalidate and fall through to DB lookup.
        await cache.delete(cacheKey);
        logger.warn("meta.processor.identity_cache_stale", { platform, identifier });
      } else {
        // T6: Guard — reject jobs for pages/accounts with known-invalid tokens
        if ((tokenRow as any).isTokenValid === false) {
          throw new UnrecoverableError(
            `${platform === "messenger" ? "Page" : "WhatsApp account"} ${identifier} token is invalid. User must reconnect. Job stopped to prevent billing waste.`
          );
        }
        const rawToken = platform === "messenger"
          ? (tokenRow as any).pageAccessToken
          : (tokenRow as any).accessToken;
        return { ...cached, accessToken: decryptFacebookSecret(rawToken) };
      }
    } catch {
      // Corrupted cache entry — fall through to DB
      await cache.delete(cacheKey);
    }
  }

  // 2. Cache miss — full DB lookup
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

    // T6: Guard — stop processing for pages with known-invalid tokens
    if (page.isTokenValid === false) {
      throw new UnrecoverableError(
        `Page ${identifier} token is invalid. User must reconnect. Job stopped to prevent billing waste.`
      );
    }

    const resolved: IdentityResolution = {
      businessProfileId: page.businessProfileId,
      businessProfile: page.businessProfile,
      accessToken: decryptFacebookSecret(page.pageAccessToken),
      responseMode: (page.responseMode || page.businessProfile!.responseMode) as "AUTO" | "MANUAL",
      pageSettings: {
        commentAutoDmEnabled: page.commentAutoDmEnabled,
        commentPublicGreeting: page.commentPublicGreeting,
      },
    };

    // 3. Cache non-sensitive fields
    const { accessToken: _token, ...cacheable } = resolved;
    cache.set(cacheKey, JSON.stringify(cacheable), IDENTITY_CACHE_TTL).catch(() => {});

    return resolved;
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

    // T6: Guard — stop processing for accounts with known-invalid tokens
    if (account.isTokenValid === false) {
      throw new UnrecoverableError(
        `WhatsApp account ${identifier} token is invalid. User must reconnect. Job stopped to prevent billing waste.`
      );
    }

    const resolved: IdentityResolution = {
      businessProfileId: account.businessProfileId,
      businessProfile: account.businessProfile,
      accessToken: decryptFacebookSecret(account.accessToken),
      responseMode: account.businessProfile!.responseMode as "AUTO" | "MANUAL",
      pageSettings: null,
    };

    const { accessToken: _token, ...cacheable } = resolved;
    cache.set(cacheKey, JSON.stringify(cacheable), IDENTITY_CACHE_TTL).catch(() => {});

    return resolved;
  }
}

/**
 * Customer Identity Resolver (Non-Blocking)
 * In production grade tier, we NEVER block the AI for Meta profile fetches.
 * We return the best known identity immediately and trigger enrichment in the background.
 */
function resolveCustomerProfile(job: MetaMessageJob) {
  const { senderName, customerName } = job;
  return {
    name: customerName || senderName || "Guest Customer",
    avatar: undefined
  };
}

/**
 * Background Profile Enrichment
 * Fetches real name/photo from Meta and updates the conversation record.
 * This happens while the AI is already working on the reply.
 */
async function enrichContactInBackground(
  conversationId: number,
  senderId: string,
  pageId: string,
  accessToken: string
) {
  try {
    const profile = await getFacebookUserProfile(senderId, pageId, accessToken);
    if (profile?.name && String(profile.name).toLowerCase() !== "null") {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          customerName: profile.name,
          customerAvatar: profile.pictureUrl || undefined
        }
      });
      logger.info("meta.processor.profile_enriched_background", { conversationId, name: profile.name });
    }
  } catch (e: any) {
    logger.warn("meta.processor.enrichment_failed", { conversationId, error: e.message });
  }
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
            const { syncBulkMessageStatus } = await import("@modules/realtime/socketSync.service");
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
        const { syncTypingStatus } = await import("@modules/realtime/socketSync.service");
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
    logger.info("meta.processor.resolving_identity", { platform, identifier });
    const { businessProfileId, businessProfile, accessToken, responseMode, pageSettings } = await resolveAccountIdentity(job);
    logger.info("meta.processor.identity_resolved", { 
      businessProfileId, 
      responseMode, 
      tokenSnippet: accessToken.substring(0, 10) + "..." 
    });

    // 2. Idempotency Check
    if (externalId) {
      const { isDuplicateWebhook } = await import("../core/webhookCache.service");
      if (await isDuplicateWebhook(externalId)) {
        logger.info("meta.processor.duplicate_ignored", { externalId });
        return;
      }

      const existing = await prisma.conversationMessage.findFirst({ where: { externalId }, select: { id: true } });
      if (existing) {
        logger.info("meta.processor.message_already_exists", { externalId });
        return;
      }
    }

    // 3. Early Returns
    if (type === "FACEBOOK_COMMENT_PUBLIC_REPLY") {
      logger.info("meta.processor.comment_public_reply_mode");
      const { replyToComment } = await import("../facebook/facebook.service");
      await replyToComment({ commentId: job.commentId!, message: messageText, accessToken, pageId: identifier, businessProfileId });
      return;
    }

    // 4. Resolve Context & Sync
    const { name: customerName } = resolveCustomerProfile(job);
    const isComment = !!job.commentId || type === "FACEBOOK_COMMENT";
    let conversationIdOverride: number | undefined;

    // ── COEXISTENCE: Mirroring Resolution for Comments ──
    // If this is a reply FROM the admin on Facebook, we need to find the conversation
    // it belongs to by looking up the parent comment we are replying to.
    if (job.isFromBusiness && isComment && job.parentId) {
      const parentMessage = await prisma.conversationMessage.findFirst({
        where: { externalId: job.parentId },
        select: { conversationId: true }
      });
      if (parentMessage) {
        conversationIdOverride = parentMessage.conversationId;
        logger.info("meta.processor.mirroring.parent_conversation_found", { 
          parentId: job.parentId, 
          conversationId: conversationIdOverride 
        });
      }
    }

    const conversation = conversationIdOverride 
      ? await prisma.conversation.findUnique({ where: { id: conversationIdOverride } })
      : await getOrCreateConversation(identifier, senderId, businessProfileId, {
          channel: isComment ? "facebook_comment" : platform,
          customerName,
          externalId: job.commentId,
          postId: job.postId,
          sourceCommentText: isComment ? messageText : undefined,
        });

    if (!conversation) {
       throw new UnrecoverableError("Could not resolve conversation for Meta message.");
    }

    // 5. Trigger Background Enrichment (Messenger only)
    if (platform === "messenger" && !job.customerName) {
      enrichContactInBackground(conversation.id, senderId, identifier, accessToken).catch(() => {});
    }

    logger.info("meta.processor.conversation_ready", { 
      conversationId: conversation.id, 
      aiEnabled: (conversation as any).aiEnabled 
    });

    const userSaved = await saveMessage(conversation.id, job.isFromBusiness ? "model" : "user", messageText || "", {
      externalId,
      type: type || "text",
      mediaId,
      mediaMetadata,
      isPrivate: platform === "messenger" ? true : (job.isPrivate ?? false),
    });

    if (job.isFromBusiness || responseMode === "MANUAL" || !(conversation as any).aiEnabled) {
      logger.info("meta.processor.skipping_ai", { 
        reason: job.isFromBusiness ? "MIRRORED_MESSAGE" : (responseMode === "MANUAL" ? "MANUAL_MODE" : "AI_DISABLED_FOR_THREAD")
      });
      return;
    }

    // 5. AI Reply Generation
    logger.info("meta.processor.computing_reply", { conversationId: conversation.id });
    const historyRows = await getConversationHistory(conversation.id, userSaved.createdAt, job.postId);
    const historyTurns = historyToLlmTurns(toPromptMessages(historyRows));

    let postContext: any;
    if (isComment && job.postId) {
      const { getPostContext, getCommentText } = await import("../facebook/facebook.service");
      const [pContext, parContext] = await Promise.all([
        getPostContext(job.postId, accessToken),
        job.parentId ? getCommentText(job.parentId, accessToken) : Promise.resolve(null)
      ]);
      if (pContext) postContext = { content: pContext.content, media: pContext.media, parentContext: parContext || undefined };
    }

    const { syncTypingStatus } = await import("@modules/realtime/socketSync.service");
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
    logger.info("meta.processor.reply_computed", { 
      action: reply.action, 
      intent: reply.intent, 
      handoff: reply.handoffCategory 
    });

    if (reply.action === "RESOLVE_CONVERSATION") {
      await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "RESOLVED" } });
      return;
    }

    // 6. Delivery Orchestration
    const isAutoMode = responseMode === "AUTO";
    const privateStatus = (isAutoMode && reply.action !== "HANDOFF_TO_HUMAN") ? "SENT" : "PENDING_REVIEW";
    const publicStatus = isAutoMode ? "SENT" : "PENDING_REVIEW";
    const mainContent = (reply.privateContent || reply.content || "").trim();

    // A. Fetch Media Attachment Details (if AI requested one)
    let aiMediaAsset: any = null;
    let syncedMediaId: string | undefined;

    if (reply.attachment && reply.attachment.assetName) {
      try {
        const mediaRecord = await prisma.businessProfileMedia.findFirst({
          where: { 
            businessProfileId, 
            name: { equals: reply.attachment.assetName, mode: "insensitive" },
            usageScope: "CHAT_ATTACHMENT",
            isActive: true,
            deletedAt: null 
          },
          include: {
            syncs: {
              where: { platform: platform === "messenger" ? "messenger" : "whatsapp", identifier }
            }
          }
        });
        
        if (mediaRecord) {
          aiMediaAsset = mediaRecord;
          const validSync = mediaRecord.syncs.find(s => s.status === "SYNCED" && (!s.expiresAt || s.expiresAt > new Date()));
          if (validSync) {
             syncedMediaId = validSync.externalMediaId;
          } else {
             logger.warn("meta.processor.media_not_synced", { assetName: reply.attachment.assetName, platform, identifier });
          }
        } else {
          logger.warn("meta.processor.media_not_found", { assetName: reply.attachment.assetName });
        }
      } catch (err) {
        logger.error("meta.processor.media_fetch_error", { error: String(err) });
      }
    }

    // B. Save Model Message
    let modelSaved: any;
    if (mainContent.length > 0 || aiMediaAsset || reply.action === "HANDOFF_TO_HUMAN") {
      modelSaved = await saveMessage(conversation.id, "model", mainContent, {
        status: privateStatus,
        aiReasoning: reply.reasoning,
        handoffCategory: (isComment && reply.intent === "SALES_DM") ? "PRIVATE_DM_REPLY" : reply.handoffCategory,
        intent: reply.intent,
        isPrivate: platform === "messenger" ? true : (isComment && reply.intent === "SALES_DM"),
        origin: isComment ? "facebook_comment_reply" : undefined,
        type: aiMediaAsset ? aiMediaAsset.mediaType : "text",
        mediaId: syncedMediaId,
        mediaMetadata: aiMediaAsset ? { url: aiMediaAsset.publicUrl, name: aiMediaAsset.name } : undefined
      });
      logger.info("meta.processor.model_saved", { messageId: modelSaved.id, status: privateStatus, hasMedia: !!aiMediaAsset });
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
        logger.info("meta.processor.public_saved", { messageId: publicSaved.id, status: publicStatus });
      }
    }

    // B. Platform Delivery
    const { mirrorCommentReplyToMessenger, syncMessageStatus } = await import("../core/metaDelivery.service");

    if (isAutoMode && reply.handoffCategory !== "SYSTEM_ERROR") {

      if (platform === "messenger") {

        // ── COMMENT DELIVERY ──────────────────────────────────────────────────
        if (isComment) {
          // IGNORE: bail before any social action
          if (reply.intent === "IGNORE") {
            logger.info("meta.processor.delivery_skipped", { reason: "IGNORE_INTENT" });
            return;
          }

          const { sendPrivateReply, replyToComment } = await import("../facebook/facebook.service");
          logger.info("meta.processor.delivering_comment", { conversationId: conversation.id });

          // Like the comment (social signal) — fires for all non-IGNORE intents
          likeComment({ commentId: job.commentId!, accessToken, pageId: identifier }).catch(() => {});

          // Public reply — fires for GREET_ONLY and SALES_DM alike, independent of mainContent
          if (publicStatus === "SENT" && publicSaved) {
            await replyToComment({ commentId: job.commentId!, message: publicSaved.content, accessToken, pageId: identifier, businessProfileId })
              .then(res => {
                logger.info("meta.processor.messenger_comment_public_success", { resId: res?.id });
                return res && syncMessageStatus(publicSaved.id, businessProfileId, conversation.id, { externalId: res.id });
              })
              .catch((err) => {
                logger.error("meta.processor.messenger_comment_public_failed", { error: err.message });
                return syncMessageStatus(publicSaved.id, businessProfileId, conversation.id, { status: "FAILED" });
              });
          }

          // Private DM — only for SALES_DM with actual content
          if (reply.intent === "SALES_DM" && privateStatus === "SENT" && modelSaved && mainContent.length > 0) {
            await sendPrivateReply({ commentId: job.commentId!, message: mainContent, accessToken, pageId: identifier, businessProfileId })
              .then(async res => {
                if (res?.id && res.id !== "ALREADY_REPLIED") {
                  logger.info("meta.processor.messenger_private_reply_success", { resId: res.id });
                  await syncMessageStatus(modelSaved.id, businessProfileId, conversation.id, { externalId: res.id });
                  await mirrorCommentReplyToMessenger({ pageId: identifier, senderId, businessProfileId, messageId: res.id, content: mainContent, intent: reply.intent, reasoning: reply.reasoning, postId: job.postId, commentId: job.commentId, role: "model" });
                } else if (res?.id === "ALREADY_REPLIED") {
                  logger.warn("meta.processor.messenger_private_reply_skipped", { reason: "ALREADY_REPLIED" });
                }
              })
              .catch((err) => {
                logger.error("meta.processor.messenger_private_reply_failed", { error: err.message });
                return syncMessageStatus(modelSaved.id, businessProfileId, conversation.id, { status: "FAILED" });
              });
          } else if (reply.intent !== "SALES_DM" && privateStatus === "SENT" && modelSaved && mainContent.length > 0) {
            // Non-sales informational reply — public comment thread
            await replyToComment({ commentId: job.commentId!, message: mainContent, accessToken, pageId: identifier, businessProfileId })
              .then(res => {
                logger.info("meta.processor.messenger_comment_info_success", { resId: res?.id });
                return res && syncMessageStatus(modelSaved.id, businessProfileId, conversation.id, { externalId: res.id });
              })
              .catch((err) => {
                logger.error("meta.processor.messenger_comment_info_failed", { error: err.message });
                return syncMessageStatus(modelSaved.id, businessProfileId, conversation.id, { status: "FAILED" });
              });
          }

        // ── MESSENGER DM DELIVERY ─────────────────────────────────────────────
        } else if (modelSaved && privateStatus === "SENT" && mainContent.length > 0) {
          logger.info("meta.processor.delivering_messenger", { conversationId: conversation.id });
          const { sendMessengerReply, sendMessengerMedia } = await import("../messenger/messenger.service");

          try {
            let res: any;
            if (aiMediaAsset && (syncedMediaId || aiMediaAsset.publicUrl)) {
              const messengerMediaType = aiMediaAsset.mediaType === "document" ? "file" : aiMediaAsset.mediaType;
              res = await sendMessengerMedia(senderId, syncedMediaId || null, messengerMediaType, accessToken, aiMediaAsset.publicUrl);
              logger.info("meta.processor.messenger_media_success", { messageId: res?.message_id });

              if (mainContent.length > 0) {
                res = await sendMessengerReply(senderId, mainContent, accessToken);
              }
            } else {
              res = await sendMessengerReply(senderId, mainContent, accessToken);
            }
            logger.info("meta.processor.messenger_reply_success", { messageId: res?.message_id });
            if (res?.message_id) await syncMessageStatus(modelSaved.id, businessProfileId, conversation.id, { externalId: res.message_id });
            const { scheduleConversationFollowUps } = await import("@modules/follow-up/followUp.service");
            await scheduleConversationFollowUps({
              conversationId: conversation.id,
              businessProfileId,
              triggerMessageId: modelSaved.id,
            });
          } catch (err: any) {
            logger.error("meta.processor.messenger_reply_failed", { error: err.message });
            await syncMessageStatus(modelSaved.id, businessProfileId, conversation.id, { status: "FAILED" });
          }
        }

      // ── WHATSAPP DELIVERY ───────────────────────────────────────────────────
      } else if (platform === "whatsapp" && modelSaved && privateStatus === "SENT" && mainContent.length > 0) {
        logger.info("meta.processor.delivering_whatsapp", { conversationId: conversation.id });
        const { sendWhatsAppReply, sendWhatsAppMedia } = await import("../whatsapp/whatsapp.service");

        try {
          let res: any;
          if (aiMediaAsset && (syncedMediaId || aiMediaAsset.publicUrl)) {
            res = await sendWhatsAppMedia(senderId, syncedMediaId || null, aiMediaAsset.mediaType, identifier, accessToken, mainContent.length > 0 ? mainContent : undefined, aiMediaAsset.name, aiMediaAsset.publicUrl);
            logger.info("meta.processor.whatsapp_media_success", { wamid: res?.messages?.[0]?.id });
          } else {
            res = await sendWhatsAppReply(senderId, mainContent, identifier, accessToken);
          }
          const wamid = res?.messages?.[0]?.id;
          logger.info("meta.processor.whatsapp_reply_success", { wamid });
          if (wamid) await prisma.conversationMessage.update({ where: { id: modelSaved.id }, data: { externalId: wamid } });
          const { scheduleConversationFollowUps } = await import("@modules/follow-up/followUp.service");
          await scheduleConversationFollowUps({
            conversationId: conversation.id,
            businessProfileId,
            triggerMessageId: modelSaved.id,
          });
        } catch (err: any) {
          logger.error("meta.processor.whatsapp_reply_failed", { error: err.message });
          await prisma.conversationMessage.update({ where: { id: modelSaved.id }, data: { status: "FAILED" } });
        }
      }

    } else {
      logger.info("meta.processor.delivery_skipped", {
        isAutoMode,
        handoff: reply.handoffCategory,
        contentLength: mainContent.length
      });
    }
  } catch (err: any) {
    if (err instanceof UnrecoverableError) throw err;
    logger.error("meta.processor.failure", { platform, identifier, error: err.message, stack: err.stack });
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
    const { createGeminiVisual, refineGeminiVisual } = await import("../../media/services/geminiVisual.service");
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








