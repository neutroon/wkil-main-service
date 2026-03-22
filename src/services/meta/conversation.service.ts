import prisma from "../../config/prisma";

const HISTORY_LIMIT = 10;

// Get or create a conversation for this sender+page combo
export async function getOrCreateConversation(
  pageId: string,
  senderId: string,
  businessProfileId: number,
) {
  return prisma.conversation.upsert({
    where: { pageId_senderId: { pageId, senderId } },
    update: { updatedAt: new Date() },
    create: { pageId, senderId, businessProfileId },
  });
}

// Get last N messages for a conversation
export async function getConversationHistory(conversationId: number) {
  const messages = await prisma.conversationMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
  });

  // Reverse to get chronological order
  return messages.reverse();
}

// Save a message to the conversation
export async function saveMessage(
  conversationId: number,
  role: "user" | "model",
  content: string,
) {
  return prisma.conversationMessage.create({
    data: { conversationId, role, content },
  });
}
