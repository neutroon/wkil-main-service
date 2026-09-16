import { UnrecoverableError } from "bullmq";
import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { cache } from "@utils/cache";
import {
  getOrCreateConversation,
  saveMessage,
} from "../core/conversation.service";
import {
  getFacebookUserProfile,
} from "../facebook/facebook.service";
import { understandInboundMedia } from "./inboundMediaUnderstanding.service";
import { enqueueOrderAction } from "@modules/order-confirmation/orderConfirmation.queue";
import { reconcileNotificationDeliveryStatus } from "@modules/order-confirmation/orderConfirmation.repository";
import {
  isWhatsAppOptOut,
  normalizeOptOutText,
} from "@modules/order-confirmation/orderConfirmation.whatsapp.parser";
import {
  inboundCustomerMessageSchema,
  type InboundCustomerMessage,
} from "./inboundCustomerMessage";
import { executeCustomerTurn } from "@modules/ai-agent/customer/customerAgent.service";
import {
  applyCustomerDecision,
  CustomerDeliveryAmbiguousError,
  type CustomerDeliveryAdapter,
} from "@modules/ai-agent/customer/customerDecision.service";

export type MetaPlatform = "messenger" | "whatsapp" | "facebook_comment" | "visual_production" | "visual_refine" | "media_sync" | "facebook" | "instagram" | "linkedin";

export interface MetaMessageJob {
  platform?: MetaPlatform;
  /** Present only for validated customer envelope jobs. */
  channel?: InboundCustomerMessage["channel"];
  identifier: string;
  senderId: string;
  messageText?: string;
  text?: string;
  receivedAt?: string;
  occurredAt?: string;
  attachments?: InboundCustomerMessage["attachments"];
  source?: "page_feed" | "group_feed";
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
  statusEvent?: "SENT" | "DELIVERED" | "READ" | "FAILED";
  statusError?: string;
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
  aiRepliesEnabled?: boolean;
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
  if (!routedBusinessProfileId || routedBusinessProfileId <= 0) {
    throw new UnrecoverableError("Meta customer job is missing its tenant route");
  }

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
              select: { accessToken: true, isTokenValid: true, aiRepliesEnabled: true }
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
          return {
            ...cached,
            ...(platform === "whatsapp"
              ? { aiRepliesEnabled: (tokenRow as any).aiRepliesEnabled }
              : {}),
            accessToken: decryptFacebookSecret(rawToken),
          };
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

    if (!page || !page.businessProfileId) {
      const candidates = await prisma.facebookPage.findMany({
        where: { pageId: identifier, businessProfileId: routedBusinessProfileId },
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

    if (!account || !account.businessProfileId) {
      const candidates = await prisma.whatsAppAccount.findMany({
        where: { phoneNumberId: identifier, businessProfileId: routedBusinessProfileId },
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
      aiRepliesEnabled: account.aiRepliesEnabled,
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
function resolveCustomerProfile(job: Pick<MetaMessageJob, "senderName" | "customerName">) {
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
  const { identifier, senderId, externalId, type } = job;
  const platform = job.platform ?? job.channel;
  const messageText = job.messageText ?? job.text ?? "";

  // Delivery receipts and order actions must never enter the AI path. Besides
  // wasting a model call, doing so delays or completely drops state changes
  // that customers expect to be immediate and idempotent.
  if (type === "status_update") {
    if (platform === "whatsapp" && externalId && job.statusEvent) {
      const status = job.statusEvent;

      await Promise.all([
        prisma.conversationMessage.updateMany({
          where: {
            externalId,
            ...(status === "FAILED" ? { status: { notIn: ["DELIVERED", "READ"] } } : {}),
          },
          data: { status },
        }),
        reconcileNotificationDeliveryStatus({
          providerMessageId: externalId,
          status,
          error: job.statusError,
        }),
      ]);
    }
    return;
  }

  if (type === "ORDER_ACTION") {
    const phoneNumberId = job.phoneNumberId || identifier;
    const customerPhone = job.customerPhone || senderId;
    const businessProfileId = job.businessProfileId;
    if (
      platform !== "whatsapp" ||
      !job.orderActionId ||
      typeof businessProfileId !== "number" ||
      !Number.isInteger(businessProfileId) ||
      !phoneNumberId ||
      !customerPhone
    ) {
      logger.warn("meta.processor.order_action_invalid", {
        platform,
        identifier,
        businessProfileId,
        inboundMessageId: externalId,
      });
      return;
    }

    const correlationId = `meta-order-action-${externalId || "unknown"}`;
    await enqueueOrderAction({
      businessProfileId,
      phoneNumberId,
      customerPhone: normalizeWhatsAppPhone(customerPhone),
      actionToken: job.orderActionId,
      inboundMessageId: externalId,
      buttonTitle: job.buttonTitle,
      correlationId,
    });
    logger.info("meta.processor.order_action_enqueued", {
      businessProfileId,
      phoneNumberId,
      inboundMessageId: externalId,
      buttonTitle: job.buttonTitle,
    });
    return;
  }

  const shouldRecordWhatsAppOptOut =
    platform === "whatsapp" &&
    !job.isFromBusiness &&
    (type === "text" || type === undefined) &&
    isWhatsAppOptOut(messageText || "");

  if (shouldRecordWhatsAppOptOut) {
    const { businessProfileId } = await resolveAccountIdentity({ ...job, platform });
    const normalizedPhone = normalizeWhatsAppPhone(job.customerPhone || senderId);
    const existing = externalId
      ? await prisma.conversationMessage.findFirst({
          where: { externalId },
          select: { id: true },
        })
      : null;
    let conversationId: number | undefined;

    if (!existing) {
      const conversation = await getOrCreateConversation(
        identifier,
        senderId,
        businessProfileId,
        {
          channel: "whatsapp",
          customerPhone: normalizedPhone,
          customerName: job.customerName,
        },
      );
      conversationId = conversation.id;
      await saveMessage(conversation.id, "user", messageText || "", {
        externalId,
        type: type || "text",
        mediaId: job.mediaId,
        mediaMetadata: job.mediaMetadata,
      });
    }

    // Keep this after message persistence. If suppression storage fails, the
    // webhook retry sees the existing message but still retries the upsert.
    await prisma.whatsAppSuppression.upsert({
      where: {
        businessProfileId_normalizedPhone: {
          businessProfileId,
          normalizedPhone,
        },
      },
      update: { reason: "CUSTOMER_OPT_OUT", source: "WHATSAPP", clearedAt: null },
      create: {
        businessProfileId,
        normalizedPhone,
        reason: "CUSTOMER_OPT_OUT",
        source: "WHATSAPP",
      },
    });
    logger.info("meta.processor.whatsapp_opt_out_recorded", {
      businessProfileId,
      normalizedPhone,
      conversationId,
      externalId,
      normalizedText: normalizeOptOutText(messageText || ""),
    });
    return;
  }

  const inbound = inboundCustomerMessageSchema.safeParse(job);
  if (!inbound.success) {
    // Non-customer Meta jobs (typing, receipts, coexistence) intentionally do
    // not share this queue envelope. Do not let malformed webhook input enter
    // an agent run.
    logger.warn("meta.processor.invalid_customer_envelope", {
      platform,
      externalId,
      issueCount: inbound.error.issues.length,
    });
    return;
  }

  await processInboundCustomerMessage(inbound.data);
}

async function processInboundCustomerMessage(inbound: InboundCustomerMessage): Promise<void> {
  const accountPlatform = inbound.channel === "whatsapp" ? "whatsapp" : "messenger";
  const identity = await resolveAccountIdentity({
    platform: accountPlatform,
    identifier: inbound.identifier,
    senderId: inbound.senderId,
    messageText: inbound.text,
    externalId: inbound.externalId,
    businessProfileId: inbound.businessProfileId,
  });

  if (identity.businessProfileId !== inbound.businessProfileId) {
    logger.warn("meta.processor.inbound_tenant_mismatch", {
      channel: inbound.channel,
      externalId: inbound.externalId,
      routedBusinessProfileId: inbound.businessProfileId,
      resolvedBusinessProfileId: identity.businessProfileId,
    });
    return;
  }

  const duplicate = await prisma.conversationMessage.findFirst({
    where: { externalId: inbound.externalId }, select: { id: true },
  });
  if (duplicate) return;

  const customer = resolveCustomerProfile({ customerName: inbound.customerName });
  const conversation = await getOrCreateConversation(
    inbound.identifier,
    inbound.senderId,
    identity.businessProfileId,
    {
      channel: inbound.channel,
      customerName: customer.name,
      ...(inbound.channel === "whatsapp" ? { customerPhone: inbound.customerPhone } : {}),
      ...(inbound.channel === "facebook_comment" ? {
        externalId: inbound.commentId,
        postId: inbound.postId,
        sourceCommentText: inbound.text,
      } : {}),
    },
  );

  const attachment = inbound.attachments[0];
  const mediaMetadata = attachment
    ? { ...(attachment.metadata ?? {}), mimeType: attachment.mimeType, url: attachment.url, title: attachment.title }
    : undefined;
  const mediaInfo = attachment && inbound.channel !== "facebook_comment"
    ? await understandInboundMedia({
        businessProfileId: identity.businessProfileId,
        userId: identity.businessProfile.userId,
        platform: inbound.channel,
        accessToken: identity.accessToken,
        mediaId: attachment.id,
        type: attachment.type,
        mediaMetadata,
      })
    : null;
  const saved = await saveMessage(conversation.id, "user", inbound.text || mediaInfo?.text || "", {
    externalId: inbound.externalId,
    type: attachment?.type ?? "text",
    mediaId: attachment?.id,
    mediaMetadata,
  });

  // Echoes are retained for audit/history but never treated as a fresh
  // customer turn. An AI-disabled conversation is the durable human-control
  // signal set by handoff and staff controls.
  if (inbound.isFromBusiness || (inbound.channel === "whatsapp" && identity.aiRepliesEnabled === false) || conversation.aiEnabled === false) return;

  const turn = await executeCustomerTurn({
    userId: identity.businessProfile.userId,
    businessProfileId: identity.businessProfileId,
    conversationId: conversation.id,
    channel: inbound.channel,
    inputMessageId: saved.id,
    customerText: inbound.text || mediaInfo?.text || "",
    runMode: "inbound",
    dedupeKey: `message:${saved.id}`,
    mediaContext: mediaInfo ? JSON.stringify(mediaInfo) : null,
  });
  await applyCustomerDecision({
    businessProfileId: identity.businessProfileId,
    conversationId: conversation.id,
    agentTurnId: turn.agentTurnId,
    decision: turn.decision,
    deliver: createCustomerDeliveryAdapter({ inbound, identity, conversation }),
  });
}

function createCustomerDeliveryAdapter(params: {
  inbound: InboundCustomerMessage;
  identity: IdentityResolution;
  conversation: { id: number; senderId: string; externalId?: string | null; postId?: string | null };
}): CustomerDeliveryAdapter {
  return async (message) => {
    try {
      if (params.inbound.channel === "whatsapp") {
        const { sendWhatsAppReply } = await import("../whatsapp/whatsapp.service");
        const response = await sendWhatsAppReply(
          params.inbound.customerPhone,
          message.content,
          params.inbound.phoneNumberId,
          params.identity.accessToken,
        ) as { messages?: Array<{ id?: string }> };
        return { externalId: response.messages?.[0]?.id ?? null };
      }
      if (params.inbound.channel === "messenger") {
        const { sendMessengerReply } = await import("../messenger/messenger.service");
        const response = await sendMessengerReply(
          params.inbound.senderId,
          message.content,
          params.identity.accessToken,
        ) as { message_id?: string };
        return { externalId: response.message_id ?? null };
      }
      return deliverFacebookCommentReply(params, message.content);
    } catch (error) {
      throw classifyCustomerDeliveryError(error);
    }
  };
}

async function deliverFacebookCommentReply(
  params: Parameters<typeof createCustomerDeliveryAdapter>[0],
  content: string,
): Promise<{ externalId?: string | null }> {
  const { replyToComment, sendPrivateReply } = await import("../facebook/facebook.service");
  const comment = params.inbound;
  if (comment.channel !== "facebook_comment") throw new Error("Facebook comment delivery requires comment context");

  const publicContent = params.identity.pageSettings?.commentAutoDmEnabled
    ? commentGreeting(params.identity.pageSettings.commentPublicGreeting, comment.customerName)
    : content;
  const publicReply = await replyToComment({
    commentId: comment.commentId,
    message: publicContent,
    accessToken: params.identity.accessToken,
    pageId: comment.pageId,
    businessProfileId: params.identity.businessProfileId,
  });

  if (!params.identity.pageSettings?.commentAutoDmEnabled) return { externalId: String(publicReply?.id ?? "") || null };

  const publicId = String(publicReply?.id ?? "");
  if (!publicId) {
    throw new CustomerDeliveryAmbiguousError(
      "Facebook public comment was accepted but its provider identity is unavailable",
    );
  }

  // The public reply is intentionally a separate conversation audit record: the
  // customer decision's primary output remains the private reply, preserving the
  // one-output-message-per-AgentTurn constraint. Saving the external ID before
  // private delivery also makes a subsequently delivered Page echo suppressible.
  try {
    await saveMessage(params.conversation.id, "model", publicContent, {
      externalId: publicId,
      status: "SENT",
      isPrivate: false,
      origin: "facebook_comment_public_reply",
    });
  } catch (error) {
    const ambiguous = new CustomerDeliveryAmbiguousError(
      "Facebook public comment was accepted but public reply audit outcome is ambiguous",
    );
    Object.defineProperty(ambiguous, "cause", { value: error, configurable: true });
    throw ambiguous;
  }

  // Meta permits one private reply within a limited window. This policy is a
  // page setting, never an instruction the model can choose for itself.
  let privateReply: { id?: string };
  try {
    privateReply = await sendPrivateReply({
      commentId: comment.commentId,
      message: content,
      accessToken: params.identity.accessToken,
      pageId: comment.pageId,
      businessProfileId: params.identity.businessProfileId,
    });
  } catch (error) {
    // The public comment was already accepted. Retrying this customer turn
    // would duplicate that public reply, while Meta's private-reply outcome
    // cannot safely be inferred from an error response alone.
    const ambiguous = new CustomerDeliveryAmbiguousError(
      "Facebook public comment was accepted but private reply outcome is ambiguous",
    );
    Object.defineProperty(ambiguous, "cause", { value: error, configurable: true });
    throw ambiguous;
  }
  const privateId = String(privateReply?.id ?? "");
  if (!privateId) {
    throw new CustomerDeliveryAmbiguousError(
      "Facebook public comment was accepted but private reply outcome is ambiguous",
    );
  }
  const { mirrorCommentReplyToMessenger } = await import("./metaDelivery.service");
  await mirrorCommentReplyToMessenger({
    pageId: comment.pageId,
    senderId: comment.senderId,
    businessProfileId: params.identity.businessProfileId,
    messageId: privateId,
    content,
    postId: comment.postId,
    commentId: comment.commentId,
    role: "model",
  });
  return { externalId: privateId };
}

function commentGreeting(template: string | undefined, customerName: string | undefined): string {
  const greeting = template?.trim() || "Thanks {{name}}! I've sent the details to your inbox.";
  return greeting.replace(/{{\s*name\s*}}/gi, customerName?.trim() || "there");
}

function classifyCustomerDeliveryError(error: unknown): unknown {
  if (error instanceof CustomerDeliveryAmbiguousError) return error;
  if (isAmbiguousTransportError(error)) {
    return new CustomerDeliveryAmbiguousError("Customer delivery transport outcome is ambiguous");
  }
  return error;
}

function isAmbiguousTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  if (code && ["ECONNRESET", "ECONNABORTED", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(code)) return true;
  return error.name === "AbortError" || /(?:network|socket|disconnect|connection reset|timed? ?out|fetch failed)/i.test(error.message);
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
    let resultAsset: any;
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
    logger.info("visual_processor.complete", { assetId: resultAsset?.id ?? null, result: resultAsset });
  } catch (err: any) {
    logger.error("visual_processor.failed", { error: err.message });
    throw err;
  }
}
