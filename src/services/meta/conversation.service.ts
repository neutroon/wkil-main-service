import prisma from "../../config/prisma";

const HISTORY_LIMIT = 10;
const INACTIVITY_HOURS = 24;

// ─── Core conversation helpers ────────────────────────────────────────────────

export async function getOrCreateConversation(
  pageId: string,
  senderId: string,
  businessProfileId: number,
  opts?: { channel?: string; customerPhone?: string },
) {
  const cutoff = new Date(Date.now() - INACTIVITY_HOURS * 60 * 60 * 1000);

  const existing = await prisma.conversation.findFirst({
    where: {
      pageId,
      senderId,
      updatedAt: { gte: cutoff },
    },
  });

  if (existing) {
    return prisma.conversation.update({
      where: { id: existing.id },
      data: {
        updatedAt: new Date(),
        // Backfill channel/phone if they were missing on an older record
        ...(opts?.channel && !existing.channel
          ? { channel: opts.channel }
          : {}),
        ...(opts?.customerPhone && !existing.customerPhone
          ? { customerPhone: opts.customerPhone }
          : {}),
      },
    });
  }

  return prisma.conversation.create({
    data: {
      pageId,
      senderId,
      businessProfileId,
      channel: opts?.channel ?? null,
      customerPhone: opts?.customerPhone ?? null,
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
  role: "user" | "model",
  content: string,
) {
  return prisma.conversationMessage.create({
    data: { conversationId, role, content },
  });
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
    channel: c.channel,
    lastMessage: c.messages[0]
      ? {
          role: c.messages[0].role,
          content: c.messages[0].content,
          createdAt: c.messages[0].createdAt,
        }
      : null,
    updatedAt: c.updatedAt,
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
  page: number,
  limit: number,
) {
  limit = Math.min(limit, MAX_LIMIT);
  const skip = (page - 1) * limit;

  const [total, messages] = await Promise.all([
    prisma.conversationMessage.count({ where: { conversationId } }),
    prisma.conversationMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
      skip,
      take: limit,
      select: {
        id: true,
        role: true,
        content: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    data: messages,
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
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
      channel: "messenger",
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
        channel: "messenger",
      },
    }),
    prisma.conversation.findMany({
      where: {
        pageId: { in: pageIds },
        channel: "messenger",
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
    channel: c.channel,
    lastMessage: c.messages[0]
      ? {
          role: c.messages[0].role,
          content: c.messages[0].content,
          createdAt: c.messages[0].createdAt,
        }
      : null,
    updatedAt: c.updatedAt,
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
