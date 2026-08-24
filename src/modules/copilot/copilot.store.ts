// src/modules/copilot/copilot.store.ts
import type { CopilotConversation, CopilotMessage, CopilotMessageRole, Prisma } from "@prisma/client";
import prisma from "@config/prisma";
import { AppError } from "@middlewares/errorHandler.middleware";

export async function getOrCreateCopilotConversation(
  userId: number,
  locale: string,
): Promise<CopilotConversation> {
  const existing = await prisma.copilotConversation.findFirst({
    where: { userId },
    orderBy: { lastMessageAt: "desc" },
  });
  if (existing) return existing;
  return prisma.copilotConversation.create({ data: { userId, locale } });
}

export async function getCopilotConversationForUser(
  conversationId: number,
  userId: number,
): Promise<CopilotConversation> {
  const conversation = await prisma.copilotConversation.findFirst({
    where: { id: conversationId, userId },
  });
  if (!conversation) throw new AppError("Copilot conversation not found", 404);
  return conversation;
}

export async function appendCopilotMessage(params: {
  conversationId: number;
  role: CopilotMessageRole;
  envelope: unknown;
}): Promise<CopilotMessage> {
  const message = await prisma.copilotMessage.create({
    data: {
      conversationId: params.conversationId,
      role: params.role,
      envelope: params.envelope as Prisma.InputJsonValue,
    },
  });
  await prisma.copilotConversation.update({
    where: { id: params.conversationId },
    data: { lastMessageAt: new Date() },
  });
  return message;
}

export async function listCopilotMessages(
  conversationId: number,
  limit: number = 20,
): Promise<CopilotMessage[]> {
  const rows = await prisma.copilotMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.reverse();
}

export async function setCopilotOnboardingStep(
  conversationId: number,
  step: string,
): Promise<void> {
  await prisma.copilotConversation.update({
    where: { id: conversationId },
    data: { onboardingStep: step },
  });
}

export async function completeCopilotOnboarding(conversationId: number): Promise<void> {
  await prisma.copilotConversation.update({
    where: { id: conversationId },
    data: { kind: "GENERAL", onboardingStep: "done" },
  });
}

export async function getCopilotMessageById(
  messageId: number,
  userId: number,
): Promise<CopilotMessage | null> {
  const msg = await prisma.copilotMessage.findFirst({
    where: { id: messageId, conversation: { userId } },
  });
  return msg;
}

export async function deleteCopilotMessagesAfter(
  conversationId: number,
  userMsgId: number,
  userId: number,
): Promise<void> {
  // Two-step: fetch the parent's created_at, then delete by strict > comparison.
  // Done in a transaction so a race with a concurrent insert can't delete the parent.
  // Scoped to user via the conversation relation: the copilot_messages table has no
  // direct user_id column, so we reach the user through conversation.userId. This
  // preserves the design's intent (defense-in-depth + no info leak) without a
  // schema migration.
  await prisma.$transaction(async (tx) => {
    const parent = await tx.copilotMessage.findFirst({
      where: { id: userMsgId, conversation: { userId } },
      select: { createdAt: true },
    });
    if (!parent) return;
    await tx.copilotMessage.deleteMany({
      where: {
        conversationId,
        conversation: { userId },
        createdAt: { gt: parent.createdAt },
      },
    });
  });
}

export async function listConversationsForUser(userId: number): Promise<CopilotConversation[]> {
  return prisma.copilotConversation.findMany({
    where: { userId },
    orderBy: { lastMessageAt: "desc" },
  });
}

export async function createConversation(userId: number, locale: string): Promise<CopilotConversation> {
  return prisma.copilotConversation.create({
    data: { userId, locale, kind: "GENERAL" },  // title defaults to null → "New chat" in UI
  });
}

export async function updateConversationTitle(
  conversationId: number,
  userId: number,
  title: string,
): Promise<void> {
  // Verify ownership first (defense in depth — controller also checks)
  const conv = await prisma.copilotConversation.findFirst({
    where: { id: conversationId, userId },
    select: { id: true },
  });
  if (!conv) throw new AppError("conversation not found", 404, false);
  await prisma.copilotConversation.update({
    where: { id: conversationId },
    data: { title: title.slice(0, 200) },  // cap to prevent abuse
  });
}

export async function deleteConversation(conversationId: number, userId: number): Promise<void> {
  // Transaction: verify ownership + cascade delete messages + delete conversation
  await prisma.$transaction(async (tx) => {
    const conv = await tx.copilotConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (!conv) throw new AppError("conversation not found", 404, false);
    await tx.copilotMessage.deleteMany({
      where: { conversationId },
    });
    await tx.copilotConversation.delete({
      where: { id: conversationId },
    });
  });
}
