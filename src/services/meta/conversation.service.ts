import prisma from "../../config/prisma";

const HISTORY_LIMIT = 10;
const INACTIVITY_HOURS = 24;

export async function getOrCreateConversation(
  pageId: string,
  senderId: string,
  businessProfileId: number,
) {
  const cutoff = new Date(Date.now() - INACTIVITY_HOURS * 60 * 60 * 1000);

  // Look for an active conversation within the last 24 hours
  const existing = await prisma.conversation.findFirst({
    where: {
      pageId,
      senderId,
      updatedAt: { gte: cutoff }, // ← only if active within 24h
    },
  });

  if (existing) {
    // Update the timestamp to keep it alive
    return prisma.conversation.update({
      where: { id: existing.id },
      data: { updatedAt: new Date() },
    });
  }

  // No active conversation — start a fresh one
  // (old one stays in DB for history/analytics)
  return prisma.conversation.create({
    data: { pageId, senderId, businessProfileId },
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
