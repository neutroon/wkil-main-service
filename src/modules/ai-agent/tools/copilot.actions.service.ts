import prisma from "@config/prisma";
import { getAccessibleProfileIds } from "@modules/auth/user/user.service";
import { conversationsController } from "@modules/inbox/inbox.controller";
import {
  listConversationMessages,
  saveMessage,
} from "@modules/meta/core/conversation.service";
import { sendWhatsAppReply } from "@modules/meta/whatsapp/whatsapp.service";
import { sendMessengerReply } from "@modules/meta/messenger/messenger.service";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import {
  listCustomers,
  updateCustomerForUser,
  reconcileCustomerStatusFromConversations,
} from "@modules/business/customer/customer.service";

const AUTHORIZED = (userId: number, conversationId: number) =>
  conversationsController.getAuthorizedConversation(userId, conversationId);

export async function sendCopilotMessage(params: {
  userId: number;
  conversationId: number;
  text: string;
}) {
  const text = params.text.trim();
  if (!text) throw new Error("text_required");
  const conversation = await AUTHORIZED(params.userId, params.conversationId);
  const channel = conversation.channel ?? "whatsapp";
  let externalId: string | undefined;
  if (channel === "whatsapp") {
    const account = await prisma.whatsAppAccount.findFirst({
      where: { phoneNumberId: conversation.pageId, userId: params.userId, isActive: true },
    });
    if (!account) throw new Error("whatsapp_account_not_found");
    const accessToken = decryptFacebookSecret(account.accessToken);
    const sent = await sendWhatsAppReply(conversation.senderId, text, account.phoneNumberId, accessToken);
    externalId = sent?.messages?.[0]?.id;
  } else if (channel === "messenger" || channel === "facebook_comment") {
    const page = await prisma.facebookPage.findFirst({
      where: { pageId: conversation.pageId, userId: params.userId, isActive: true },
    });
    if (!page) throw new Error("facebook_page_not_found");
    const pageAccessToken = decryptFacebookSecret(page.pageAccessToken);
    const sent = await sendMessengerReply(conversation.senderId, text, pageAccessToken);
    externalId = sent?.message_id;
  } else if (channel !== "web") {
    throw new Error("unsupported_channel");
  }
  const message = await saveMessage(params.conversationId, "agent", text, {
    ...(externalId ? { externalId } : {}),
    ...(channel === "web" ? { status: "SENT" as const } : {}),
  });
  return { ok: true, message };
}

export async function setCopilotConversationStatus(params: {
  userId: number;
  conversationId: number;
  status: "OPEN" | "RESOLVED" | "ARCHIVED";
}) {
  const conversation = await AUTHORIZED(params.userId, params.conversationId);
  const updated = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { status: params.status },
  });
  if (conversation.customerId && (params.status === "RESOLVED" || params.status === "OPEN")) {
    await reconcileCustomerStatusFromConversations(params.userId, conversation.customerId);
  }
  return { ok: true, conversation: updated };
}

export async function toggleCopilotConversationAi(params: {
  userId: number;
  conversationId: number;
  enabled: boolean;
}) {
  const conversation = await AUTHORIZED(params.userId, params.conversationId);
  const updated = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { aiEnabled: params.enabled },
  });
  return { ok: true, conversation: updated };
}

export async function markCopilotConversationRead(params: {
  userId: number;
  conversationId: number;
}) {
  const conversation = await AUTHORIZED(params.userId, params.conversationId);
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { readAt: new Date() },
  });
  return { ok: true };
}

export async function updateCopilotCustomer(params: {
  userId: number;
  customerId: number;
  data: { status?: string; notes?: string | null; displayName?: string };
}) {
  const customer = await updateCustomerForUser(params.userId, params.customerId, {
    ...(params.data.status ? { status: params.data.status as any } : {}),
    ...(params.data.notes !== undefined ? { notes: params.data.notes } : {}),
    ...(params.data.displayName ? { displayName: params.data.displayName } : {}),
  });
  return { ok: true, customer };
}

const CONVERSATION_LIST_SELECT = {
  id: true,
  channel: true,
  status: true,
  aiEnabled: true,
  readAt: true,
  updatedAt: true,
  customerId: true,
  customer: { select: { id: true, displayName: true, phone: true } },
  messages: {
    orderBy: { id: "desc" as const },
    take: 1,
    select: { role: true, content: true, createdAt: true },
  },
} as const;

function channelWhere(channel?: string) {
  if (!channel) return undefined;
  if (channel === "whatsapp") return { OR: [{ channel: "whatsapp" }, { channel: null }] };
  if (channel === "messenger") return { in: ["messenger", "facebook_comment"] };
  return channel;
}

function statusWhere(status?: string) {
  if (!status) return undefined;
  return status.toUpperCase() === "ARCHIVED" ? "ARCHIVED" : { not: "ARCHIVED" };
}

export async function listCopilotConversations(params: {
  userId: number;
  businessProfileId?: number;
  status?: string;
  channel?: string;
  q?: string;
  limit?: number;
}) {
  const profileIds = await getAccessibleProfileIds(params.userId);
  const scoped = params.businessProfileId
    ? profileIds.filter((id: number) => id === params.businessProfileId)
    : profileIds;
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
  const conversations = await prisma.conversation.findMany({
    where: {
      businessProfileId: { in: scoped },
      ...(channelWhere(params.channel) ? { channel: channelWhere(params.channel) } : {}),
      ...(statusWhere(params.status) ? { status: statusWhere(params.status) } : {}),
      ...(params.q ? { customer: { displayName: { contains: params.q } } } : {}),
    },
    select: CONVERSATION_LIST_SELECT,
    orderBy: { updatedAt: "desc" },
    take: limit,
  });
  const rows = conversations.map((c: any) => ({
    id: c.id,
    channel: c.channel ?? "whatsapp",
    status: c.status,
    aiEnabled: c.aiEnabled,
    readAt: c.readAt,
    updatedAt: c.updatedAt,
    customerId: c.customerId,
    customerName: c.customer?.displayName ?? null,
    customerPhone: c.customer?.phone ?? null,
    lastMessage: c.messages?.[0]
      ? { role: c.messages[0].role, content: c.messages[0].content, createdAt: c.messages[0].createdAt }
      : null,
  }));
  return {
    conversations: rows,
    envelopes: [
      {
        type: "conversation-list",
        conversations: rows.map((r: any) => ({
          id: r.id,
          customerName: r.customerName,
          channel: r.channel,
          preview: r.lastMessage?.content ?? null,
        })),
        total: rows.length,
        cite: { tool: "list_conversations", fetchedAt: new Date().toISOString(), deepLink: "/inbox" },
      },
    ],
  };
}

export async function getCopilotConversationMessages(params: {
  userId: number;
  conversationId: number;
  limit?: number;
  cursor?: number;
}) {
  const conversation = await conversationsController.getAuthorizedConversation(
    params.userId,
    params.conversationId,
  );
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const result = await listConversationMessages(params.conversationId, limit, params.cursor);
  return { conversation, ...result };
}

export async function listCopilotCustomers(params: {
  userId: number;
  q?: string;
  status?: string;
  limit?: number;
}) {
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
  return listCustomers({
    userId: params.userId,
    q: params.q,
    status: params.status,
    page: 1,
    limit,
  });
}
