import prisma, { Prisma } from "@config/prisma";
import { AppError } from "@middlewares/errorHandler.middleware";
import { getAccessibleProfileIds } from "@modules/auth/user/user.service";

const DEFAULT_STATUS = "ACTIVE";
const FOLLOW_UP_STATUS = "NEEDS_FOLLOW_UP";

const customerMemorySelect = {
  id: true,
  businessProfileId: true,
  displayName: true,
  phone: true,
  normalizedPhone: true,
  email: true,
  normalizedEmail: true,
  avatarUrl: true,
  primaryChannel: true,
  externalIds: true,
  capturedFields: true,
  lastInteractionAt: true,
} satisfies Prisma.CustomerSelect;

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function normalizeCustomerPhone(value: unknown): string | null {
  const text = cleanString(value);
  if (!text) return null;
  const normalized = text.replace(/[^\d+]/g, "");
  return normalized || null;
}

export function normalizeCustomerEmail(value: unknown): string | null {
  const text = cleanString(value);
  if (!text || !text.includes("@")) return null;
  return text.toLowerCase();
}

function preferredDisplayName(params: {
  displayName?: string | null;
  phone?: string | null;
  email?: string | null;
  senderId?: string | null;
}) {
  return (
    cleanString(params.displayName) ||
    cleanString(params.phone) ||
    cleanString(params.email) ||
    cleanString(params.senderId) ||
    "Customer"
  );
}

function mergeJsonObject(
  current: Prisma.JsonValue | null | undefined,
  incoming: Record<string, unknown>,
) {
  const base =
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  return { ...base, ...incoming };
}

function mergeExternalIds(
  current: Prisma.JsonValue | null | undefined,
  channel: string,
  externalId: string,
) {
  const base =
    current && typeof current === "object" && !Array.isArray(current)
      ? ({ ...(current as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  const existing = Array.isArray(base[channel]) ? (base[channel] as unknown[]) : [];
  base[channel] = Array.from(new Set([...existing.map(String), externalId]));
  return base;
}

async function findCustomerByIdentity(params: {
  businessProfileId: number;
  channel?: string | null;
  externalId?: string | null;
  normalizedPhone?: string | null;
  normalizedEmail?: string | null;
}) {
  const channel = cleanString(params.channel);
  const externalId = cleanString(params.externalId);

  if (channel && externalId) {
    const identity = await prisma.customerExternalIdentity.findUnique({
      where: {
        businessProfileId_channel_externalId: {
          businessProfileId: params.businessProfileId,
          channel,
          externalId,
        },
      },
      include: { customer: true },
    });
    if (identity?.customer) return identity.customer;
  }

  if (params.normalizedPhone) {
    const byPhone = await prisma.customer.findUnique({
      where: {
        businessProfileId_normalizedPhone: {
          businessProfileId: params.businessProfileId,
          normalizedPhone: params.normalizedPhone,
        },
      },
    });
    if (byPhone) return byPhone;
  }

  if (params.normalizedEmail) {
    const byEmail = await prisma.customer.findUnique({
      where: {
        businessProfileId_normalizedEmail: {
          businessProfileId: params.businessProfileId,
          normalizedEmail: params.normalizedEmail,
        },
      },
    });
    if (byEmail) return byEmail;
  }

  return null;
}

async function attachExternalIdentity(params: {
  customerId: number;
  businessProfileId: number;
  channel?: string | null;
  externalId?: string | null;
}) {
  const channel = cleanString(params.channel);
  const externalId = cleanString(params.externalId);
  if (!channel || !externalId) return;

  const identity = await prisma.customerExternalIdentity.upsert({
    where: {
      businessProfileId_channel_externalId: {
        businessProfileId: params.businessProfileId,
        channel,
        externalId,
      },
    },
    create: {
      businessProfileId: params.businessProfileId,
      customerId: params.customerId,
      channel,
      externalId,
    },
    update: {},
  });

  if (identity.customerId !== params.customerId) {
    await mergeCustomerIdentity({
      targetCustomerId: identity.customerId,
      sourceCustomerId: params.customerId,
    });
  }
}

export async function upsertCustomerFromConversation(params: {
  businessProfileId: number;
  conversationId?: number;
  channel?: string | null;
  senderId: string;
  customerPhone?: string | null;
  customerName?: string | null;
  customerAvatar?: string | null;
  email?: string | null;
}) {
  const channel = cleanString(params.channel) || "web";
  const phone = cleanString(params.customerPhone) || (channel === "whatsapp" ? params.senderId : null);
  const email = cleanString(params.email);
  const normalizedPhone = normalizeCustomerPhone(phone);
  const normalizedEmail = normalizeCustomerEmail(email);
  const displayName = preferredDisplayName({
    displayName: params.customerName,
    phone,
    email,
    senderId: params.senderId,
  });
  const now = new Date();

  let customer = await findCustomerByIdentity({
    businessProfileId: params.businessProfileId,
    channel,
    externalId: params.senderId,
    normalizedPhone,
    normalizedEmail,
  });

  if (!customer) {
    customer = await prisma.customer.create({
      data: {
        businessProfileId: params.businessProfileId,
        displayName,
        phone,
        normalizedPhone,
        email,
        normalizedEmail,
        avatarUrl: cleanString(params.customerAvatar),
        primaryChannel: channel,
        externalIds: mergeExternalIds(null, channel, params.senderId),
        lastInteractionAt: now,
      },
    });
  } else {
    customer = await prisma.customer.update({
      where: { id: customer.id },
      data: {
        displayName:
          displayName !== params.senderId && displayName !== customer.displayName
            ? displayName
            : customer.displayName,
        phone: customer.phone || phone,
        normalizedPhone: customer.normalizedPhone || normalizedPhone,
        email: customer.email || email,
        normalizedEmail: customer.normalizedEmail || normalizedEmail,
        avatarUrl: cleanString(params.customerAvatar) || customer.avatarUrl,
        primaryChannel: customer.primaryChannel || channel,
        externalIds: mergeExternalIds(customer.externalIds, channel, params.senderId),
        lastInteractionAt: now,
      },
    });
  }

  await attachExternalIdentity({
    customerId: customer.id,
    businessProfileId: params.businessProfileId,
    channel,
    externalId: params.senderId,
  });

  if (params.conversationId) {
    await prisma.conversation.updateMany({
      where: { id: params.conversationId, businessProfileId: params.businessProfileId },
      data: { customerId: customer.id },
    });
  }

  return customer;
}

export async function updateCustomerFromSavedDetails(params: {
  businessProfileId: number;
  conversationId?: number | null;
  details: Record<string, unknown>;
}) {
  const details = { ...params.details };
  delete details.idempotencyKey;
  delete details.conversationId;
  delete details.customerId;

  const conversation = params.conversationId
    ? await prisma.conversation.findFirst({
        where: { id: params.conversationId, businessProfileId: params.businessProfileId },
        select: {
          id: true,
          businessProfileId: true,
          customerId: true,
          channel: true,
          senderId: true,
          customerName: true,
          customerPhone: true,
          customerAvatar: true,
        },
      })
    : null;

  const phone = cleanString(details.phone) || conversation?.customerPhone || (conversation?.channel === "whatsapp" ? conversation.senderId : null);
  const email = cleanString(details.email);
  const normalizedPhone = normalizeCustomerPhone(phone);
  const normalizedEmail = normalizeCustomerEmail(email);

  let customer =
    (conversation?.customerId
      ? await prisma.customer.findFirst({
          where: { id: conversation.customerId, businessProfileId: params.businessProfileId },
          select: customerMemorySelect,
        })
      : null) ||
    (await findCustomerByIdentity({
      businessProfileId: params.businessProfileId,
      channel: conversation?.channel,
      externalId: conversation?.senderId,
      normalizedPhone,
      normalizedEmail,
    }));

  if (!customer) {
    customer = await prisma.customer.create({
      data: {
        businessProfileId: params.businessProfileId,
        displayName: preferredDisplayName({
          displayName: cleanString(details.name) || conversation?.customerName,
          phone,
          email,
          senderId: conversation?.senderId,
        }),
        phone,
        normalizedPhone,
        email,
        normalizedEmail,
        avatarUrl: conversation?.customerAvatar || null,
        primaryChannel: conversation?.channel || null,
        externalIds:
          conversation?.channel && conversation.senderId
            ? mergeExternalIds(null, conversation.channel, conversation.senderId)
            : undefined,
        capturedFields: details as Prisma.InputJsonObject,
        status: DEFAULT_STATUS,
        lastInteractionAt: new Date(),
      },
      select: customerMemorySelect,
    });
  }

  const updated = await prisma.customer.update({
    where: { id: customer.id },
    data: {
      displayName: cleanString(details.name) || customer.displayName,
      phone: customer.phone || phone,
      normalizedPhone: customer.normalizedPhone || normalizedPhone,
      email: customer.email || email,
      normalizedEmail: customer.normalizedEmail || normalizedEmail,
      capturedFields: mergeJsonObject(customer.capturedFields, details) as Prisma.InputJsonObject,
      lastInteractionAt: new Date(),
    },
  });

  if (conversation) {
    if (conversation.customerId !== updated.id) {
      await prisma.conversation.updateMany({
        where: { id: conversation.id, businessProfileId: params.businessProfileId },
        data: { customerId: updated.id },
      });
    }
    await attachExternalIdentity({
      customerId: updated.id,
      businessProfileId: params.businessProfileId,
      channel: conversation.channel || "web",
      externalId: conversation.senderId,
    });
  }

  return updated;
}

export async function mergeCustomerIdentity(params: {
  targetCustomerId: number;
  sourceCustomerId: number;
}) {
  if (params.targetCustomerId === params.sourceCustomerId) return;

  const [target, source] = await Promise.all([
    prisma.customer.findUnique({ where: { id: params.targetCustomerId } }),
    prisma.customer.findUnique({ where: { id: params.sourceCustomerId } }),
  ]);
  if (!target || !source || target.businessProfileId !== source.businessProfileId) return;

  await prisma.$transaction([
    prisma.conversation.updateMany({
      where: { customerId: source.id },
      data: { customerId: target.id },
    }),
    prisma.customerExternalIdentity.updateMany({
      where: { customerId: source.id },
      data: { customerId: target.id },
    }),
    prisma.crmDeliveryLog.updateMany({
      where: { customerId: source.id },
      data: { customerId: target.id },
    }),
    prisma.customer.update({
      where: { id: target.id },
      data: {
        phone: target.phone || source.phone,
        normalizedPhone: target.normalizedPhone || source.normalizedPhone,
        email: target.email || source.email,
        normalizedEmail: target.normalizedEmail || source.normalizedEmail,
        avatarUrl: target.avatarUrl || source.avatarUrl,
        capturedFields: mergeJsonObject(target.capturedFields, (source.capturedFields || {}) as Record<string, unknown>) as Prisma.InputJsonObject,
        lastInteractionAt:
          target.lastInteractionAt > source.lastInteractionAt
            ? target.lastInteractionAt
            : source.lastInteractionAt,
      },
    }),
    prisma.customer.delete({ where: { id: source.id } }),
  ]);
}

export async function listCustomers(params: {
  userId: number;
  businessProfileId?: number;
  q?: string;
  status?: string;
  channel?: string;
  page?: number;
  limit?: number;
}) {
  const profileIds = await getAccessibleProfileIds(params.userId);
  const allowedProfileIds = params.businessProfileId
    ? profileIds.filter((id) => id === params.businessProfileId)
    : profileIds;
  if (allowedProfileIds.length === 0) {
    return { data: [], meta: { total: 0, page: 1, limit: params.limit || 25, totalPages: 0 } };
  }

  const page = Math.max(1, params.page || 1);
  const limit = Math.min(100, Math.max(1, params.limit || 25));
  const where: Prisma.CustomerWhereInput = {
    businessProfileId: { in: allowedProfileIds },
  };
  const andFilters: Prisma.CustomerWhereInput[] = [];

  const q = cleanString(params.q);
  if (q) {
    andFilters.push({
      OR: [
        { displayName: { contains: q, mode: "insensitive" } },
        { phone: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
      ],
    });
  }

  if (params.status && params.status !== "all") {
    if (params.status === "captured") {
      where.capturedFields = { not: Prisma.JsonNull };
    } else if (params.status === "handoff") {
      where.conversations = {
        some: { messages: { some: { handoffCategory: { not: null } } } },
      };
    } else if (params.status === "needs-follow-up") {
      where.status = FOLLOW_UP_STATUS;
    } else {
      where.status = params.status.toUpperCase();
    }
  }

  if (params.channel && params.channel !== "all") {
    andFilters.push({
      OR: [
        { primaryChannel: params.channel },
        { externalIdentities: { some: { channel: params.channel } } },
      ],
    });
  }

  if (andFilters.length > 0) where.AND = andFilters;

  const [total, customers] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      orderBy: { lastInteractionAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        businessProfile: { select: { id: true, name: true } },
        externalIdentities: true,
        conversations: {
          orderBy: { updatedAt: "desc" },
          take: 1,
          include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
        },
        _count: { select: { conversations: true, crmDeliveryLogs: true } },
      },
    }),
  ]);

  return {
    data: customers.map(serializeCustomerSummary),
    meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
}

export async function getCustomerForUser(userId: number, customerId: number) {
  const profileIds = await getAccessibleProfileIds(userId);
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, businessProfileId: { in: profileIds } },
    include: {
      businessProfile: { select: { id: true, name: true } },
      externalIdentities: true,
      conversations: {
        orderBy: { updatedAt: "desc" },
        take: 10,
        include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
      },
      crmDeliveryLogs: { orderBy: { createdAt: "desc" }, take: 10 },
      _count: { select: { conversations: true, crmDeliveryLogs: true } },
    },
  });
  if (!customer) throw new AppError("Customer not found", 404);
  return serializeCustomerDetail(customer);
}

export async function updateCustomerForUser(
  userId: number,
  customerId: number,
  data: {
    displayName?: string;
    phone?: string | null;
    email?: string | null;
    status?: string;
    notes?: string | null;
  },
) {
  const existing = await getCustomerForUser(userId, customerId);
  const phone = data.phone !== undefined ? cleanString(data.phone) : undefined;
  const email = data.email !== undefined ? cleanString(data.email) : undefined;
  const updated = await prisma.customer.update({
    where: { id: existing.id },
    data: {
      displayName: data.displayName ? data.displayName.trim() : undefined,
      phone,
      normalizedPhone: phone !== undefined ? normalizeCustomerPhone(phone) : undefined,
      email,
      normalizedEmail: email !== undefined ? normalizeCustomerEmail(email) : undefined,
      status: data.status,
      notes: data.notes,
    },
  });
  return getCustomerForUser(userId, updated.id);
}

export async function listCustomerConversations(userId: number, customerId: number) {
  await getCustomerForUser(userId, customerId);
  const rows = await prisma.conversation.findMany({
    where: { customerId },
    orderBy: { updatedAt: "desc" },
    include: { messages: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  return rows.map(serializeConversationLink);
}

function serializeConversationLink(conversation: any) {
  const lastMessage = conversation.messages?.[0];
  return {
    id: conversation.id,
    channel: conversation.channel,
    status: conversation.status,
    senderId: conversation.senderId,
    customerName: conversation.customerName,
    customerPhone: conversation.customerPhone,
    updatedAt: conversation.updatedAt,
    lastMessage: lastMessage
      ? {
          role: lastMessage.role,
          content: lastMessage.content,
          createdAt: lastMessage.createdAt,
          handoffCategory: lastMessage.handoffCategory,
        }
      : null,
  };
}

function serializeCustomerSummary(customer: any) {
  return {
    id: customer.id,
    businessProfileId: customer.businessProfileId,
    businessProfileName: customer.businessProfile?.name,
    displayName: customer.displayName,
    phone: customer.phone,
    email: customer.email,
    avatarUrl: customer.avatarUrl,
    primaryChannel: customer.primaryChannel,
    status: customer.status,
    notes: customer.notes,
    capturedFields: customer.capturedFields || {},
    externalIdentities: customer.externalIdentities || [],
    lastInteractionAt: customer.lastInteractionAt,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
    conversationCount: customer._count?.conversations || 0,
    crmDeliveryCount: customer._count?.crmDeliveryLogs || 0,
    lastConversation: customer.conversations?.[0]
      ? serializeConversationLink(customer.conversations[0])
      : null,
  };
}

function serializeCustomerDetail(customer: any) {
  return {
    ...serializeCustomerSummary(customer),
    metadata: customer.metadata || {},
    conversations: (customer.conversations || []).map(serializeConversationLink),
    crmDeliveryLogs: (customer.crmDeliveryLogs || []).map((log: any) => ({
      id: log.id,
      integrationId: log.integrationId,
      eventType: log.eventType,
      status: log.status,
      attempts: log.attempts,
      lastError: log.lastError,
      deliveredAt: log.deliveredAt,
      createdAt: log.createdAt,
    })),
  };
}
