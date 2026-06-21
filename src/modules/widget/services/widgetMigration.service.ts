import prisma from "@config/prisma";
import { logger } from "@utils/logger";

/**
 * Migrate/merge conversations when an anonymous visitor identifies as a known user.
 *
 * Best practice (Intercom pattern):
 * - If the user already has a conversation (e.g. from mobile), merge the anonymous
 *   conversation into it: move all messages, then delete the empty anonymous conversation.
 * - If the user has no existing conversation, simply re-assign the anonymous conversation
 *   to the new senderId.
 *
 * After this call, there is exactly ONE conversation for (pageId, visitorId, channel="web").
 *
 * @returns the ID of the surviving conversation (or undefined if none existed)
 */
export async function mergeVisitorConversations(
  pageId: string,
  newVisitorId: string,
  previousVisitorId: string,
): Promise<number | undefined> {
  if (!previousVisitorId || previousVisitorId === newVisitorId) return undefined;

  // Find the primary conversation (the identified user's existing conversation)
  const primary = await prisma.conversation.findFirst({
    where: { senderId: newVisitorId, pageId, channel: "web" },
    orderBy: { createdAt: "asc" }, // oldest = the original thread
    select: { id: true },
  });

  // Find the anonymous conversation(s) to merge
  const anonymous = await prisma.conversation.findFirst({
    where: { senderId: previousVisitorId, pageId, channel: "web" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

  if (!anonymous) {
    // Nothing to merge
    return primary?.id;
  }

  if (primary) {
    // Both exist → merge: move messages from anonymous → primary, delete anonymous
    await prisma.$transaction([
      prisma.conversationMessage.updateMany({
        where: { conversationId: anonymous.id },
        data: { conversationId: primary.id },
      }),
      prisma.conversation.delete({ where: { id: anonymous.id } }),
    ]);
    logger.info("widget.conversation_merged", {
      primaryId: primary.id,
      mergedFromId: anonymous.id,
      from: previousVisitorId.slice(0, 16),
      to: newVisitorId.slice(0, 16),
    });
    return primary.id;
  }

  // No primary → just re-assign anonymous conversation to the new visitorId
  await prisma.conversation.update({
    where: { id: anonymous.id },
    data: { senderId: newVisitorId },
  });
  logger.info("widget.conversation_migrated", {
    conversationId: anonymous.id,
    from: previousVisitorId.slice(0, 16),
    to: newVisitorId.slice(0, 16),
  });
  return anonymous.id;
}
