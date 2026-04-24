import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function mergeDuplicateConversations() {
  console.log('--- Starting Conversation Merge & Cleanup ---');

  // 1. Find all (senderId, pageId) pairs with more than 1 conversation
  const duplicates = await prisma.$queryRaw<any[]>`
    SELECT "senderId", "pageId", COUNT(*) as count
    FROM "Conversation"
    WHERE "senderId" IS NOT NULL AND "pageId" IS NOT NULL
    GROUP BY "senderId", "pageId"
    HAVING COUNT(*) > 1
  `;

  console.log(`Found ${duplicates.length} users with duplicate conversations.`);

  for (const dup of duplicates) {
    const { senderId, pageId } = dup;

    // 2. Fetch all conversations for this user
    const convs = await prisma.conversation.findMany({
      where: { senderId, pageId },
      orderBy: [
        { channel: 'desc' }, // Prioritize 'messenger' (m) over 'facebook_comment' (f)
        { updatedAt: 'desc' }
      ]
    });

    if (convs.length < 2) continue;

    const mainConv = convs[0];
    const otherConvs = convs.slice(1);

    console.log(`Merging ${otherConvs.length} conversations into main thread (ID: ${mainConv.id}, Channel: ${mainConv.channel}) for user ${senderId}`);

    for (const other of otherConvs) {
      // Move messages
      await prisma.conversationMessage.updateMany({
        where: { conversationId: other.id },
        data: { conversationId: mainConv.id }
      });

      // Delete the duplicate
      await prisma.conversation.delete({
        where: { id: other.id }
      });
    }
  }

  console.log('--- Cleanup Completed ---');
}

mergeDuplicateConversations()
  .catch((err) => {
    console.error('Cleanup failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
