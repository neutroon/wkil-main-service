import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function run() {
  const messages = await prisma.conversationMessage.findMany({
    orderBy: { id: 'desc' },
    take: 10,
    include: {
        conversation: true
    }
  });
  console.log(JSON.stringify(messages.map(m => ({
    id: m.id,
    content: m.content.slice(0, 50),
    status: m.status,
    externalId: m.externalId,
    intent: m.intent,
    createdAt: m.createdAt,
    pageId: m.conversation.pageId
  })), null, 2));

  // Check the page settings too
  const pages = await prisma.facebookPage.findMany();
  console.log("Pages Settings:", JSON.stringify(pages.map(p => ({
    pageId: p.pageId,
    commentAutoDmEnabled: p.commentAutoDmEnabled,
    isActive: p.isActive
  })), null, 2));
}
run().catch(console.error).finally(() => prisma.$disconnect());
