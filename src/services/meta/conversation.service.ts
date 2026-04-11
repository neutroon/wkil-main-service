import prisma from "../../config/prisma";

const HISTORY_LIMIT = 10;

// ─── Core conversation helpers ────────────────────────────────────────────────

export async function getOrCreateConversation(
  pageId: string,
  senderId: string,
  businessProfileId: number,
  opts?: { channel?: string; customerPhone?: string; customerName?: string; customerAvatar?: string },
) {
  // 1. Try to find an existing conversation for this specific channel
  const existing = await prisma.conversation.findFirst({
    where: {
      pageId,
      senderId,
      channel: opts?.channel ?? null,
    },
    orderBy: {
      updatedAt: "desc",
    },
  });

  if (existing) {
    const updateData: any = {};

    // Always update phone if provided and missing
    if (opts?.customerPhone && !existing.customerPhone) {
      updateData.customerPhone = opts.customerPhone;
    }
    // Update name if provided and DIFFERENT (or missing)
    if (opts?.customerName && opts.customerName !== existing.customerName) {
      updateData.customerName = opts.customerName;
    }
    // Update avatar if provided and different
    if (opts?.customerAvatar && opts.customerAvatar !== existing.customerAvatar) {
      updateData.customerAvatar = opts.customerAvatar;
    }
    // Sync channel if needed
    if (opts?.channel && !existing.channel) {
      updateData.channel = opts.channel;
    }

    if (Object.keys(updateData).length > 0) {
      return prisma.conversation.update({
        where: { id: existing.id },
        data: { ...updateData, updatedAt: new Date() },
      });
    }
    return existing;
  }

  // 2. If creating a NEW Messenger conversation, try to link it to the most recent comment thread
  let parentConversationId: number | null = null;
  if (opts?.channel === "messenger") {
    const lastCommentThread = await prisma.conversation.findFirst({
      where: {
        pageId,
        senderId,
        channel: "facebook_comment"
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true }
    });
    if (lastCommentThread) {
      parentConversationId = lastCommentThread.id;
    }
  }

  // 3. Create a brand new conversation
  return prisma.conversation.create({
    data: {
      pageId,
      senderId,
      businessProfileId,
      channel: opts?.channel ?? null,
      customerPhone: opts?.customerPhone ?? null,
      customerName: opts?.customerName ?? null,
      customerAvatar: opts?.customerAvatar ?? null,
      parentConversationId,
      readAt: null,
    },
  });
}

export async function getConversationHistory(conversationId: number) {
  const messages = await prisma.conversationMessage.findMany({
    where: { conversationId },
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
    status?: string | null;
    aiReasoning?: string | null;
    handoffCategory?: string | null;
  }
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
    },
  });

  // Always bump the conversation updatedAt whenever a message is saved
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });

  return msg;
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
) {
  limit = Math.min(limit, MAX_LIMIT);
  const skip = (page - 1) * limit;

  // Resolve all phoneNumberIds owned by this user
  const accounts = await prisma.whatsAppAccount.findMany({
    where: { userId, isActive: true },
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
        OR: [{ channel: "whatsapp" }, { channel: null }],
      },
    }),
    prisma.conversation.findMany({
      where: {
        pageId: { in: phoneNumberIds },
        OR: [{ channel: "whatsapp" }, { channel: null }],
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
 * Return paginated messages for a single conversation.
 * Caller must have already verified the conversation belongs to the user.
 */
export async function listConversationMessages(
  conversationId: number,
  limit: number,
  cursor?: number,
) {
  limit = Math.min(limit, MAX_LIMIT);

  const where: any = { conversationId };
  if (cursor) {
    where.id = { lt: cursor };
  }

  const messages = await prisma.conversationMessage.findMany({
    where,
    orderBy: { id: "desc" },
    take: limit,
    select: {
      id: true,
      role: true,
      content: true,
      type: true,
      mediaId: true,
      mediaMetadata: true,
      status: true,
      aiReasoning: true,
      handoffCategory: true,
      createdAt: true,
    },
  });

  const nextCursor = messages.length > 0 ? messages[messages.length - 1].id : null;
  const hasMore = messages.length === limit;

  return {
    data: messages,
    meta: {
      limit,
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
) {
  const MAX_LIMIT = 100;
  limit = Math.min(limit, MAX_LIMIT);
  const skip = (page - 1) * limit;

  // Resolve all pageIds owned by this user
  const pages = await prisma.facebookPage.findMany({
    where: { facebookAccount: { userId }, isActive: true },
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
        channel: { in: ["messenger", "facebook_comment"] },
      },
    }),
    prisma.conversation.findMany({
      where: {
        pageId: { in: pageIds },
        channel: { in: ["messenger", "facebook_comment"] },
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
    businessProfileId: c.businessProfileId,
    pageId: c.pageId,
    pageName: pageMap[c.pageId] ?? c.pageId,
    senderId: c.senderId,
    customerName: c.customerName,
    customerAvatar: c.customerAvatar,
    channel: c.channel,
    externalId: c.externalId,
    postId: c.postId,
    processingStatus: c.processingStatus,
    lastMessage: c.messages[0]
      ? {
          role: c.messages[0].role,
          content: c.messages[0].content,
          type: c.messages[0].type,
          mediaId: c.messages[0].mediaId,
          createdAt: c.messages[0].createdAt,
          status: c.messages[0].status,
          handoffCategory: c.messages[0].handoffCategory,
        }
      : null,
    updatedAt: c.updatedAt,
    readAt: c.readAt,
    createdAt: c.createdAt,
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
