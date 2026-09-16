import prisma from "@config/prisma";
import { Prisma, type ConversationMessageStatus } from "@prisma/client";
import { AppError, ProviderDeliveryRejectedError } from "@middlewares/errorHandler.middleware";
import { getAccessibleProfileIds } from "@modules/auth/user/user.service";
import {
  reconcileCustomerStatusFromConversations,
  upsertCustomerFromConversation,
} from "@modules/business/customer/customer.service";
import { runOutsideDbQueryTrace } from "@utils/dbQueryTrace";
import { logger } from "@utils/logger";
import { CustomerDeliveryAmbiguousError } from "@modules/ai-agent/customer/customerDecision.service";
import { createHash } from "crypto";

const HISTORY_LIMIT = 24;

export type ConversationLockDatabase = {
  $executeRaw(query: Prisma.Sql): Promise<number>;
};

export function getConversationIdentityLockKey(
  pageId: string,
  senderId: string,
  businessProfileId: number,
  channel?: string | null,
) {
  return JSON.stringify([businessProfileId, pageId, senderId, channel ?? null]);
}

export async function lockConversationIdentity(
  db: ConversationLockDatabase,
  pageId: string,
  senderId: string,
  businessProfileId: number,
  channel?: string | null,
) {
  const lockKey = getConversationIdentityLockKey(
    pageId,
    senderId,
    businessProfileId,
    channel,
  );
  await db.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
}

async function attachCustomerMemory(
  conversation: any,
  opts?: {
    channel?: string;
    customerPhone?: string;
    customerName?: string;
    customerAvatar?: string;
  },
  db: any = prisma,
) {
  const customer = await upsertCustomerFromConversation({
    businessProfileId: conversation.businessProfileId,
    conversationId: conversation.id,
    channel: opts?.channel ?? conversation.channel,
    senderId: conversation.senderId,
    customerPhone: opts?.customerPhone ?? conversation.customerPhone,
    customerName: opts?.customerName ?? conversation.customerName,
    customerAvatar: opts?.customerAvatar ?? conversation.customerAvatar,
    db,
  });
  return { ...conversation, customerId: customer.id };
}

// ─── Core conversation helpers ────────────────────────────────────────────────

type ConversationOptions = {
  channel?: string;
  customerPhone?: string;
  customerName?: string;
  customerAvatar?: string;
  externalId?: string;
  postId?: string;
  sourceCommentText?: string;
};

async function getOrCreateConversationWithDb(
  db: any,
  pageId: string,
  senderId: string,
  businessProfileId: number,
  opts?: ConversationOptions,
) {
  await lockConversationIdentity(
    db,
    pageId,
    senderId,
    businessProfileId,
    opts?.channel ?? null,
  );

  // Comment conversations are anchored to the source comment, not merely the
  // commenter. Reusing a generic Page/PSID conversation here overwrites the
  // comment ID and loses the public thread identity needed for safe replies.
  const commentThread = opts?.channel === "facebook_comment" && opts.externalId
    ? await db.conversation.findFirst({
        where: { externalId: opts.externalId, businessProfileId, channel: "facebook_comment" },
      })
    : null;

  // 1. Try to find an existing primary conversation for this user on this page
  const existing = commentThread ?? (opts?.channel === "facebook_comment"
    ? null
    : await db.conversation.findFirst({
    where: {
      pageId,
      senderId,
      businessProfileId,
      channel: opts?.channel ?? null,
    },
    orderBy: { updatedAt: "desc" },
  }));

  if (existing) {
    const updateData: any = {};

    // Always update phone if provided and missing
    if (opts?.customerPhone && !existing.customerPhone) {
      updateData.customerPhone = opts.customerPhone;
    }
    // Update name if provided and DIFFERENT (or missing)
    if (
      opts?.customerName &&
      opts.customerName !== existing.customerName &&
      opts.customerName !== "Guest Customer"
    ) {
      updateData.customerName = opts.customerName;
    }
    // Update avatar if provided and different
    if (
      opts?.customerAvatar &&
      opts.customerAvatar !== existing.customerAvatar
    ) {
      updateData.customerAvatar = opts.customerAvatar;
    }
    // Sync channel if needed
    if (opts?.channel && !existing.channel) {
      updateData.channel = opts.channel;
    }

    // ELITE IDENTITY: Always refresh externalId, postId, and sourceCommentText
    if (opts?.externalId) {
      updateData.externalId = opts.externalId;
    }
    if (opts?.postId) {
      updateData.postId = opts.postId;
    }
    if (opts?.sourceCommentText && !existing.sourceCommentText) {
      updateData.sourceCommentText = opts.sourceCommentText;
    }

    // WAKE UP: Automatically reopen conversation if it was resolved/snoozed
    const wasResolved = existing.status === "RESOLVED";
    if (existing.status !== "OPEN") {
      updateData.status = "OPEN";
    }

    if (Object.keys(updateData).length > 0) {
      const updated = await db.conversation.update({
        where: { id: existing.id },
        data: { ...updateData, updatedAt: new Date() },
      });
      const withCustomer = await attachCustomerMemory(updated, opts, db);
      // Customer sent a new message on a RESOLVED thread — flip the
      // owning customer back to ACTIVE so the sales view reflects
      // the new open conversation immediately. Fire-and-forget so we
      // never block the message-write path on a slow reconcile.
      if (wasResolved && withCustomer.customerId) {
        void reconcileOnWake(withCustomer.businessProfileId, withCustomer.customerId);
      }
      return withCustomer;
    }
    return attachCustomerMemory(existing, opts, db);
  }

  // 2. If creating a NEW Messenger conversation, try to link it to the most recent comment thread
  let parentConversationId: number | null = null;
  if (opts?.channel === "messenger") {
    const lastCommentThread = await db.conversation.findFirst({
      where: {
        pageId,
        senderId,
        channel: "facebook_comment",
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    if (lastCommentThread) {
      parentConversationId = lastCommentThread.id;
    }
  }

  // 3. Create a brand new conversation
  const created = await db.conversation.create({
    data: {
      pageId,
      senderId,
      businessProfileId,
      channel: opts?.channel ?? null,
      customerPhone: opts?.customerPhone ?? null,
      customerName: opts?.customerName ?? null,
      customerAvatar: opts?.customerAvatar ?? null,
      externalId: opts?.externalId ?? null,
      postId: opts?.postId ?? null,
      sourceCommentText: opts?.sourceCommentText ?? null,
      parentConversationId,
      readAt: null,
    },
  });
  return attachCustomerMemory(created, opts, db);
}

export async function getOrCreateConversation(
  pageId: string,
  senderId: string,
  businessProfileId: number,
  opts?: ConversationOptions,
) {
  return prisma.$transaction((transaction) =>
    getOrCreateConversationWithDb(
      transaction,
      pageId,
      senderId,
      businessProfileId,
      opts,
    ),
  );
}

export async function getConversationHistory(
  conversationId: number,
  before?: Date,
  postId?: string,
) {
  // ELITE TIER: Multi-Post Safety
  // If we are in a post-bound conversation, we strictly only pull history from that SAME post.
  const messages = await prisma.conversationMessage.findMany({
    where: {
      conversationId,
      conversation: postId ? { postId } : {}, // Ensure cross-post isolation
      ...(before ? { createdAt: { lte: before } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
  });

  return messages.reverse();
}

export async function saveMessage(
  conversationId: number,
  role: "user" | "model" | "agent",
  content: string,
  opts?: {
    externalId?: string | null;
    type?: string;
    mediaId?: string | null;
    mediaMetadata?: any;
    status?: ConversationMessageStatus | null;
    aiReasoning?: string | null;
    handoffCategory?: string | null;
    intent?: string | null;
    isPrivate?: boolean;
    origin?: string | null;
  },
) {
  const msg = await prisma.conversationMessage.create({
    data: {
      conversationId,
      role,
      content,
      externalId: opts?.externalId,
      type: opts?.type || "text",
      mediaId: opts?.mediaId,
      mediaMetadata: opts?.mediaMetadata,
      status: opts?.status || "SENT",
      aiReasoning: opts?.aiReasoning,
      handoffCategory: opts?.handoffCategory,
      intent: opts?.intent,
      isPrivate: opts?.isPrivate ?? false,
      origin: opts?.origin,
    },
  });

  runMessagePersistenceSideEffectsInBackground({
    conversationId,
    messageId: msg.id,
    role,
  });

  return msg;
}

export async function saveManualReplyAndTakeHumanControl(params: {
  businessProfileId: number;
  conversationId: number;
  channel: string | null;
  content: string;
  isPrivate: boolean;
  origin: string;
  idempotencyKey: string;
  deliver: (message: any) => Promise<{ externalId?: string | null } | void>;
}) {
  const requestHash = createHash("sha256").update(JSON.stringify({
    content: params.content,
    isPrivate: params.isPrivate,
    origin: params.origin,
  })).digest("hex");
  const existing = await findManualReplyByIdempotencyKey(params);
  if (existing) return assertSameManualReplyRequest(existing, requestHash);

  let message: any;
  try {
    message = await prisma.$transaction(async (db) => {
      const controlTransition = await db.conversation.updateMany({
        where: {
          id: params.conversationId,
          businessProfileId: params.businessProfileId,
        },
        data: { aiEnabled: false },
      });
      if (controlTransition.count !== 1) {
        throw new Error("Manual reply conversation scope is no longer available");
      }

      return db.conversationMessage.create({
        data: {
          conversationId: params.conversationId,
          role: "agent",
          content: params.content,
          status: "SENDING",
          isPrivate: params.isPrivate,
          origin: params.origin,
          manualReplyIdempotencyKey: params.idempotencyKey,
          manualReplyRequestHash: requestHash,
        },
      });
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const concurrent = await findManualReplyByIdempotencyKey(params);
    if (!concurrent) throw error;
    return assertSameManualReplyRequest(concurrent, requestHash);
  }

  await syncManualReplySoft(params, message);

  runMessagePersistenceSideEffectsInBackground({
    conversationId: params.conversationId,
    messageId: message.id,
    role: "agent",
  });

  // Disabling AI is the durable safety boundary. Queue removal is best-effort
  // because a BullMQ job can already be active; active jobs re-check aiEnabled
  // before delivery and therefore remain harmless.
  try {
    const { cancelConversationFollowUps } = await import("@modules/follow-up/followUp.service");
    await cancelConversationFollowUps(params.conversationId);
  } catch (error: any) {
    logger.warn("conversation.manual_reply.follow_up_cancel_failed", {
      businessProfileId: params.businessProfileId,
      conversationId: params.conversationId,
      error: error?.message || String(error),
    });
  }

  let provider: { externalId?: string | null } | void;
  try {
    provider = await params.deliver(message);
  } catch (error) {
    if (error instanceof CustomerDeliveryAmbiguousError) throw error;
    if (error instanceof ProviderDeliveryRejectedError) {
      const failed = await prisma.conversationMessage.updateMany({
        where: { id: message.id, conversationId: params.conversationId, status: "SENDING" },
        data: { status: "FAILED" },
      }).catch(() => ({ count: 0 }));
      if (failed.count === 1) {
        await syncManualReplySoft(params, { ...message, status: "FAILED" });
      }
      throw error;
    }
    const ambiguous = new CustomerDeliveryAmbiguousError(
      "Manual reply transport outcome is ambiguous",
    );
    Object.defineProperty(ambiguous, "cause", { value: error, configurable: true });
    throw ambiguous;
  }

  const externalId = provider?.externalId ?? null;
  if (!externalId) {
    throw new CustomerDeliveryAmbiguousError(
      "Meta accepted the manual reply but did not return a message ID",
    );
  }

  try {
    const confirmation = await prisma.conversationMessage.updateMany({
      where: { id: message.id, conversationId: params.conversationId, status: "SENDING" },
      data: { status: "SENT", externalId },
    });
    if (confirmation.count !== 1) {
      throw new Error("Manual reply delivery confirmation was not persisted");
    }
  } catch (error) {
    const ambiguous = new CustomerDeliveryAmbiguousError(
      "Meta accepted the manual reply but local confirmation is ambiguous",
    );
    Object.defineProperty(ambiguous, "cause", { value: error, configurable: true });
    throw ambiguous;
  }

  const sentMessage = { ...message, status: "SENT" as const, externalId };
  await syncManualReplySoft(params, sentMessage);
  return sentMessage;
}

async function findManualReplyByIdempotencyKey(params: {
  businessProfileId: number;
  conversationId: number;
  idempotencyKey: string;
}) {
  return prisma.conversationMessage.findFirst({
    where: {
      conversationId: params.conversationId,
      manualReplyIdempotencyKey: params.idempotencyKey,
      conversation: { businessProfileId: params.businessProfileId },
    },
  });
}

function assertSameManualReplyRequest(message: any, requestHash: string) {
  if (message.manualReplyRequestHash !== requestHash) {
    throw new AppError("Idempotency-Key was already used for a different manual reply", 409);
  }
  return message;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && (error as { code?: unknown }).code === "P2002";
}

async function syncManualReplySoft(
  params: {
    businessProfileId: number;
    conversationId: number;
    channel: string | null;
  },
  message: any,
) {
  try {
    const { syncManualReply } = await import("@modules/realtime/socketSync.service");
    syncManualReply({
      businessProfileId: params.businessProfileId,
      conversationId: params.conversationId,
      channel: params.channel,
      message,
    });
  } catch (error: any) {
    logger.warn("conversation.manual_reply.realtime_sync_failed", {
      businessProfileId: params.businessProfileId,
      conversationId: params.conversationId,
      messageId: message.id,
      error: error?.message || String(error),
    });
  }
}

function runMessagePersistenceSideEffectsInBackground(params: {
  conversationId: number;
  messageId: number;
  role: "user" | "model" | "agent";
}) {
  runOutsideDbQueryTrace(() => {
    setImmediate(() => {
      touchConversationAfterMessageSave(params).catch((error: any) => {
        logger.warn("conversation.message_side_effects_failed", {
          conversationId: params.conversationId,
          messageId: params.messageId,
          role: params.role,
          error: error?.message || String(error),
        });
      });
    });
  });
}

async function touchConversationAfterMessageSave(params: {
  conversationId: number;
  messageId: number;
  role: "user" | "model" | "agent";
}) {
  const touchedAt = new Date();
  const conversation = await prisma.conversation.update({
    where: { id: params.conversationId },
    data: { updatedAt: touchedAt },
    select: {
      id: true,
      businessProfileId: true,
      customerId: true,
      channel: true,
      updatedAt: true,
    },
  });

  if (conversation.customerId) {
    await prisma.customer.updateMany({
      where: { id: conversation.customerId },
      data: { lastInteractionAt: touchedAt },
    });
  }
}

// ─── UI / inbox helpers ───────────────────────────────────────────────────────

const MAX_LIMIT = 100;

/**
 * Return paginated WhatsApp conversations that belong to the authenticated user,
 * filtered via that user's registered phoneNumberId values.
 */
export async function listWhatsAppConversations(
  userId: number,
  page: number,
  limit: number,
  status?: string,
) {
  limit = Math.min(limit, MAX_LIMIT);
  const skip = (page - 1) * limit;

  // 1. Resolve all BusinessProfiles this user has access to
  const profileIds = await getAccessibleProfileIds(userId);

  if (profileIds.length === 0) {
    return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
  }

  // 2. Resolve all phoneNumberIds linked to these profiles
  const accounts = await prisma.whatsAppAccount.findMany({
    where: { businessProfileId: { in: profileIds }, isActive: true },
    select: { phoneNumberId: true, displayPhoneNumber: true },
  });

  const phoneNumberIds = accounts.map((a) => a.phoneNumberId);

  if (phoneNumberIds.length === 0) {
    return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
  }

  // Build phoneNumberId → displayPhoneNumber map for enrichment
  const phoneMap = Object.fromEntries(
    accounts.map((a) => [a.phoneNumberId, a.displayPhoneNumber]),
  );

  const [total, rows] = await Promise.all([
    prisma.conversation.count({
      where: {
        pageId: { in: phoneNumberIds },
        businessProfileId: { in: profileIds },
        OR: [{ channel: "whatsapp" }, { channel: null }],
        status: status === "ARCHIVED" ? "ARCHIVED" : { not: "ARCHIVED" },
      },
    }),
    prisma.conversation.findMany({
      where: {
        pageId: { in: phoneNumberIds },
        businessProfileId: { in: profileIds },
        OR: [{ channel: "whatsapp" }, { channel: null }],
        status: status === "ARCHIVED" ? "ARCHIVED" : { not: "ARCHIVED" },
      },
      orderBy: { updatedAt: "desc" },
      skip,
      take: limit,
      include: {
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1, // last message preview
        },
      },
    }),
  ]);

  const data = rows.map((c) => ({
    id: c.id,
    customerId: c.customerId,
    businessProfileId: c.businessProfileId,
    phoneNumberId: c.pageId,
    displayPhoneNumber: phoneMap[c.pageId] ?? c.pageId,
    customerPhone: c.customerPhone ?? c.senderId,
    customerName: c.customerName,
    customerAvatar: c.customerAvatar,
    channel: c.channel,
    lastMessage: c.messages[0]
      ? {
          role: c.messages[0].role,
          content: c.messages[0].content,
          type: c.messages[0].type,
          mediaId: c.messages[0].mediaId,
          createdAt: c.messages[0].createdAt,
        }
      : null,
    updatedAt: c.updatedAt,
    readAt: c.readAt,
    createdAt: c.createdAt,
    senderId: c.senderId,
    status: c.status,
    aiEnabled: c.aiEnabled ?? true,
  }));

  return {
    data,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * Return paginated messages for a conversation.
 * ELITE TIER: Messenger threads now perform "Thread Convergence" — pulling in
 * Private DM replies from associated Facebook Comment threads to provide
 * a "typical messenger flow" history.
 */
export async function listConversationMessages(
  conversationId: number,
  limit: number,
  cursor?: number,
) {
  limit = Math.min(limit, MAX_LIMIT);

  // 1. Fetch the base conversation to identify the user and page
  const mainConv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, senderId: true, pageId: true, channel: true },
  });

  if (!mainConv) throw new AppError("Conversation not found", 404);

  let messageWhere: any = { conversationId };
  if (cursor !== undefined) {
    const cursorAnchor = await prisma.conversationMessage.findUnique({
      where: { id: cursor },
      select: { id: true, conversationId: true, createdAt: true },
    });

    if (cursorAnchor?.conversationId === conversationId) {
      messageWhere = {
        conversationId,
        OR: [
          { createdAt: { lt: cursorAnchor.createdAt } },
          { createdAt: cursorAnchor.createdAt, id: { lt: cursorAnchor.id } },
        ],
      };
    } else {
      // Preserve the legacy numeric-cursor behavior if an old/deleted cursor
      // cannot be resolved to a timestamp anchor.
      messageWhere = { conversationId, id: { lt: cursor } };
    }
  }

  const messages = await prisma.conversationMessage.findMany({
    where: messageWhere,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    include: {
      conversation: {
        select: {
          id: true,
          channel: true,
          postId: true,
          externalId: true,
        },
      },
    },
  });

  // 4. Transform and enrich
  const data = messages.map((m) => ({
    id: m.id,
    role: m.role as any,
    content: m.content,
    type: m.type,
    mediaId: m.mediaId,
    mediaMetadata: (m.mediaMetadata as any) || {},
    status: m.status,
    aiReasoning: m.aiReasoning,
    handoffCategory: m.handoffCategory,
    intent: m.intent,
    isPrivate: m.isPrivate,
    origin: m.origin,
    createdAt: m.createdAt,
  }));

  const nextCursor =
    messages.length > 0 ? messages[messages.length - 1].id : null;
  const hasMore = messages.length === limit;

  return {
    data,
    meta: {
      nextCursor,
      hasMore,
    },
  };
}

/**
 * Check that a conversation's pageId is one of the given phoneNumberIds.
 * Returns the conversation or null if access is denied.
 */
export async function getConversationForUser(
  conversationId: number,
  phoneNumberIds: string[],
) {
  return prisma.conversation.findFirst({
    where: {
      id: conversationId,
      pageId: { in: phoneNumberIds },
      OR: [{ channel: "whatsapp" }, { channel: null }],
    },
  });
}

/**
 * Check that a Messenger conversation's pageId is one of the given pageIds.
 */
export async function getMessengerConversationForUser(
  conversationId: number,
  pageIds: string[],
) {
  return prisma.conversation.findFirst({
    where: {
      id: conversationId,
      pageId: { in: pageIds },
      channel: { in: ["messenger", "facebook_comment"] },
    },
  });
}

/**
 * Return paginated Messenger conversations that belong to the authenticated user,
 * filtered via that user's connected facebookPageId values.
 */
export async function listMessengerConversations(
  userId: number,
  page: number,
  limit: number,
  channel: "messenger" | "facebook_comment" = "messenger",
  status?: string,
) {
  const MAX_LIMIT = 100;
  limit = Math.min(limit, MAX_LIMIT);
  const skip = (page - 1) * limit;

  // 1. Resolve all BusinessProfiles this user has access to
  const profileIds = await getAccessibleProfileIds(userId);

  if (profileIds.length === 0) {
    return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
  }

  // 2. Resolve all pageIds linked to these profiles
  const pages = await prisma.facebookPage.findMany({
    where: { businessProfileId: { in: profileIds }, isActive: true },
    select: { pageId: true, pageName: true },
  });

  const pageIds = pages.map((p) => p.pageId);

  if (pageIds.length === 0) {
    return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
  }

  // Build pageId -> pageName map for enrichment
  const pageMap = Object.fromEntries(pages.map((p) => [p.pageId, p.pageName]));

  const [total, rows] = await Promise.all([
    prisma.conversation.count({
      where: {
        pageId: { in: pageIds },
        channel: channel,
        status: status === "ARCHIVED" ? "ARCHIVED" : { not: "ARCHIVED" },
      },
    }),
    prisma.conversation.findMany({
      where: {
        pageId: { in: pageIds },
        channel: channel,
        status: status === "ARCHIVED" ? "ARCHIVED" : { not: "ARCHIVED" },
      },
      orderBy: { updatedAt: "desc" },
      skip,
      take: limit,
      include: {
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1, // last message preview
        },
      },
    }),
  ]);

  const data = rows.map((c: any) => ({
    id: c.id,
    customerId: c.customerId,
    businessProfileId: c.businessProfileId,
    pageId: c.pageId,
    pageName: pageMap[c.pageId] ?? c.pageId,
    senderId: c.senderId,
    customerName: c.customerName,
    customerAvatar: c.customerAvatar,
    channel: c.channel,
    externalId: c.externalId,
    postId: c.postId,
    postUrl: c.postUrl,
    sourceCommentText: c.sourceCommentText,
    processingStatus: c.processingStatus,
    aiEnabled: c.aiEnabled,
    lastMessage: c.messages[0]
      ? {
          role: c.messages[0].role,
          content: c.messages[0].content,
          type: c.messages[0].type,
          mediaId: c.messages[0].mediaId,
          createdAt: c.messages[0].createdAt,
          status: c.messages[0].status,
          handoffCategory: c.messages[0].handoffCategory,
          intent: c.messages[0].intent,
        }
      : null,
    updatedAt: c.updatedAt,
    readAt: c.readAt,
    createdAt: c.createdAt,
    status: c.status,
  }));

  return {
    data,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  };
}

/**
 * When a customer message auto-reopens a conversation, re-derive the
 * owning customer's status (RESOLVED → ACTIVE if this was the last
 * RESOLVED thread). Best-effort: any failure is logged, never thrown,
 * because the customer message has already been persisted by the time
 * we get here.
 */
async function reconcileOnWake(
  businessProfileId: number,
  customerId: number,
): Promise<void> {
  try {
    const profile = await prisma.businessProfile.findUnique({
      where: { id: businessProfileId },
      select: { userId: true },
    });
    if (!profile) return;
    await reconcileCustomerStatusFromConversations(
      profile.userId,
      customerId,
    );
  } catch (err) {
    logger.warn("customer_status.wake_reconcile_failed", {
      businessProfileId,
      customerId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
