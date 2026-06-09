import prisma from "@config/prisma";
import type { ConversationMessageStatus } from "@prisma/client";
import { AppError } from "@middlewares/errorHandler.middleware";
import { getAccessibleProfileIds } from "@modules/auth/user/user.service";
import { upsertCustomerFromConversation } from "@modules/business/customer/customer.service";
import { runOutsideDbQueryTrace } from "@utils/dbQueryTrace";
import { logger } from "@utils/logger";

const HISTORY_LIMIT = 24;

async function attachCustomerMemory(
  conversation: any,
  opts?: {
    channel?: string;
    customerPhone?: string;
    customerName?: string;
    customerAvatar?: string;
  },
) {
  const customer = await upsertCustomerFromConversation({
    businessProfileId: conversation.businessProfileId,
    conversationId: conversation.id,
    channel: opts?.channel ?? conversation.channel,
    senderId: conversation.senderId,
    customerPhone: opts?.customerPhone ?? conversation.customerPhone,
    customerName: opts?.customerName ?? conversation.customerName,
    customerAvatar: opts?.customerAvatar ?? conversation.customerAvatar,
  });
  return { ...conversation, customerId: customer.id };
}

// ─── Core conversation helpers ────────────────────────────────────────────────

export async function getOrCreateConversation(
  pageId: string,
  senderId: string,
  businessProfileId: number,
  opts?: {
    channel?: string;
    customerPhone?: string;
    customerName?: string;
    customerAvatar?: string;
    externalId?: string;
    postId?: string;
    sourceCommentText?: string;
  },
) {
  // 1. Try to find an existing primary conversation for this user on this page
  const existing = await prisma.conversation.findFirst({
    where: {
      pageId,
      senderId,
      businessProfileId,
      channel: opts?.channel ?? null,
    },
    orderBy: { updatedAt: "desc" },
  });

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
    if (existing.status !== "OPEN") {
      updateData.status = "OPEN";
    }

    if (Object.keys(updateData).length > 0) {
      const updated = await prisma.conversation.update({
        where: { id: existing.id },
        data: { ...updateData, updatedAt: new Date() },
      });
      return attachCustomerMemory(updated, opts);
    }
    return attachCustomerMemory(existing, opts);
  }

  // 2. If creating a NEW Messenger conversation, try to link it to the most recent comment thread
  let parentConversationId: number | null = null;
  if (opts?.channel === "messenger") {
    const lastCommentThread = await prisma.conversation.findFirst({
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
  const created = await prisma.conversation.create({
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
  return attachCustomerMemory(created, opts);
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

  const messages = await prisma.conversationMessage.findMany({
    where: {
      conversationId: conversationId,
      ...(cursor ? { id: { lt: cursor } } : {}),
    },
    orderBy: { id: "desc" },
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
