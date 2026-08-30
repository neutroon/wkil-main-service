import { AgentClient } from "@modules/ai-agent/client/agent.client";
import { UnrecoverableError } from "bullmq";
import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { cache } from "@utils/cache";
import {
  getFacebookUserProfile,
  likeComment,
} from "../facebook/facebook.service";
import { understandInboundMedia } from "./inboundMediaUnderstanding.service";
import { createLatencyTrace } from "@utils/latencyTrace";
import { enqueueOrderAction } from "@modules/order-confirmation/orderConfirmation.queue";
import {
  isWhatsAppOptOut,
  normalizeOptOutText,
} from "@modules/order-confirmation/orderConfirmation.whatsapp.parser";

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
  customerPhone?: string;
  from?: string;
  mediaId?: string;
  mediaMetadata?: any;
  customerName?: string;
  orderActionId?: string;
  buttonTitle?: string;
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

type MetaProcessorTraceOptions = {
  jobId?: string;
  jobName?: string;
  queueWaitMs?: number;
};

interface IdentityResolution {
  businessProfileId: number;
  businessProfile: any;
  accessToken: string;
  pageSettings: {
    commentAutoDmEnabled?: boolean;
    commentPublicGreeting?: string;
  } | null;
}

/** Cached identity payload — accessToken is intentionally excluded (fetched fresh from DB) */
type CachedIdentity = Omit<IdentityResolution, "accessToken">;

const IDENTITY_CACHE_TTL = 900; // 15 minutes

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeWhatsAppPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits ? `+${digits}` : phone;
}

async function clearMessengerIdentityCaches(pageId: string) {
  await Promise.all([
    cache.delete(`identity:messenger:${pageId}`),
    cache.delete(`cache:routable_page:${pageId}`),
    cache.delete(`cache:known_page:${pageId}`),
  ]).catch(() => {});
}

function describeConnectionCandidate(candidate: any) {
  return {
    id: candidate.id,
    businessProfileId: candidate.businessProfileId,
    isActive: candidate.isActive,
    isTokenValid: candidate.isTokenValid,
    accountIsActive: candidate.facebookAccount?.isActive,
    accountTokenValid: candidate.facebookAccount?.isTokenValid,
    userId: candidate.userId ?? candidate.facebookAccount?.userId,
    updatedAt: candidate.updatedAt,
  };
}

async function clearWhatsAppIdentityCaches(phoneNumberId: string) {
  await Promise.all([
    cache.delete(`identity:whatsapp:${phoneNumberId}`),
    cache.delete(`cache:known_wa:${phoneNumberId}`),
  ]).catch(() => {});
}

/**
 * Identity & Account Resolver — with 15-minute Redis cache.
 *
 * Strategy:
 * - The heavy JOIN query result (businessProfile + agentActionSources)
 *   is cached for 15 minutes to protect the DB on high-volume webhook spikes.
 * - The accessToken is NEVER cached in Redis. On a cache hit, we do a fast single-field
 *   indexed lookup (pageId/phoneNumberId) to get the fresh token.
 * - Cache is invalidated on every: connect, disconnect, link, unlink, settings change.
 */
async function resolveAccountIdentity(job: MetaMessageJob): Promise<IdentityResolution> {
  const { platform, identifier } = job;
  const cacheKey = `identity:${platform}:${identifier}`;
  const routedBusinessProfileId = Number.isInteger(job.businessProfileId)
    ? job.businessProfileId
    : undefined;

  // 1. Try cache (non-sensitive data only)
  const cachedRaw = await cache.get<string>(cacheKey);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw) as CachedIdentity;
      if (
        routedBusinessProfileId &&
        cached.businessProfileId !== routedBusinessProfileId
      ) {
        await cache.delete(cacheKey);
        logger.warn("meta.processor.identity_cache_route_mismatch", {
          platform,
          identifier,
          cachedBusinessProfileId: cached.businessProfileId,
          routedBusinessProfileId,
        });
      } else {
        logger.debug("meta.processor.identity_cache_hit", {
          platform,
          identifier,
          businessProfileId: cached.businessProfileId,
        });

        // Fetch ONLY the token — fast indexed single-field query
        const tokenRow = platform === "messenger"
          ? await prisma.facebookPage.findFirst({
              where: {
                pageId: identifier,
                isActive: true,
                businessProfileId: cached.businessProfileId,
              },
              select: { pageAccessToken: true, isTokenValid: true }
            })
          : await prisma.whatsAppAccount.findFirst({
              where: {
                phoneNumberId: identifier,
                isActive: true,
                businessProfileId: cached.businessProfileId,
              },
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
      }
    } catch {
      // Corrupted cache entry — fall through to DB
      await cache.delete(cacheKey);
    }
  }

  // 2. Cache miss — full DB lookup
  if (platform === "messenger") {
    const findFacebookPageIdentity = (businessProfileId?: number) =>
      prisma.facebookPage.findFirst({
        where: {
          pageId: identifier,
          isActive: true,
          facebookAccount: { isActive: true },
          ...(businessProfileId
            ? { businessProfileId }
            : { businessProfileId: { not: null } }),
        },
        orderBy: { updatedAt: "desc" },
        include: {
          businessProfile: {
            include: {
              agentActionSources: { where: { isActive: true } },
            },
          },
        },
      });

    let page = await findFacebookPageIdentity(routedBusinessProfileId);

    if (!page || !page.businessProfileId) {
      await clearMessengerIdentityCaches(identifier);
      await wait(300);
      page = await findFacebookPageIdentity(routedBusinessProfileId);
    }

    if (!page && routedBusinessProfileId) {
      page = await findFacebookPageIdentity();
      if (page?.businessProfileId) {
        logger.warn("meta.processor.identity_route_changed", {
          platform,
          identifier,
          routedBusinessProfileId,
          resolvedBusinessProfileId: page.businessProfileId,
        });
      }
    }

    if (!page || !page.businessProfileId) {
      const candidates = await prisma.facebookPage.findMany({
        where: { pageId: identifier },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: {
          id: true,
          businessProfileId: true,
          isActive: true,
          isTokenValid: true,
          updatedAt: true,
          facebookAccount: {
            select: {
              userId: true,
              isActive: true,
              isTokenValid: true,
            },
          },
        },
      });
      logger.warn("meta.processor.identity_missing_profile_retryable", {
        platform,
        identifier,
        routedBusinessProfileId,
        candidates: candidates.map(describeConnectionCandidate),
      });
      throw new Error(`Messenger page ${identifier} is not connected to a profile.`);
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
    const findWhatsAppAccountIdentity = (businessProfileId?: number) =>
      prisma.whatsAppAccount.findFirst({
        where: {
          phoneNumberId: identifier,
          isActive: true,
          ...(businessProfileId
            ? { businessProfileId }
            : { businessProfileId: { not: null } }),
        },
        include: {
          businessProfile: {
            include: {
              agentActionSources: { where: { isActive: true } },
            },
          },
        },
      });

    let account = await findWhatsAppAccountIdentity(routedBusinessProfileId);

    if (!account || !account.businessProfileId) {
      await clearWhatsAppIdentityCaches(identifier);
      await wait(300);
      account = await findWhatsAppAccountIdentity(routedBusinessProfileId);
    }

    if (!account && routedBusinessProfileId) {
      account = await findWhatsAppAccountIdentity();
      if (account?.businessProfileId) {
        logger.warn("meta.processor.identity_route_changed", {
          platform,
          identifier,
          routedBusinessProfileId,
          resolvedBusinessProfileId: account.businessProfileId,
        });
      }
    }

    if (!account || !account.businessProfileId) {
      const candidates = await prisma.whatsAppAccount.findMany({
        where: { phoneNumberId: identifier },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: {
          id: true,
          businessProfileId: true,
          isActive: true,
          isTokenValid: true,
          updatedAt: true,
        },
      });
      logger.warn("meta.processor.identity_missing_profile_retryable", {
        platform,
        identifier,
        routedBusinessProfileId,
        candidates: candidates.map(describeConnectionCandidate),
      });
      throw new Error(`WhatsApp account ${identifier} is not connected to a profile.`);
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

function channelForLatencyTrace(job: MetaMessageJob) {
  if (job.commentId || job.type === "FACEBOOK_COMMENT") return "facebook_comment";
  if (job.platform === "whatsapp") return "whatsapp";
  return "messenger";
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
      const updatedConversation = await prisma.conversation.update({
        where: { id: conversationId },
        data: {
          customerName: profile.name,
          customerAvatar: profile.pictureUrl || undefined
        },
        select: {
          customerId: true,
        },
      });
      if (updatedConversation.customerId) {
        await prisma.customer.update({
          where: { id: updatedConversation.customerId },
          data: {
            displayName: profile.name,
            avatarUrl: profile.pictureUrl || undefined,
          },
        });
      }
      logger.info("meta.processor.profile_enriched_background", { conversationId, name: profile.name });
    }
  } catch (e: any) {
    logger.warn("meta.processor.enrichment_failed", { conversationId, error: e.message });
  }
}

/**
 * High-Resilience Unified Meta Processor.
 */
export async function processMetaMessage(
  job: MetaMessageJob,
  traceOptions: MetaProcessorTraceOptions = {},
) {
  return AgentClient.runCustomerAgent({
    business_profile_id: job.businessProfileId,
    user_id: undefined,
    messages: [],
    stage: "fast",
    channel: job.platform,
  } as any) as any;
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
