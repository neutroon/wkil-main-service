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
    createdAt: m.createdAt,
    sender: m.sender,
    channel: m.conversation.channel
  })), null, 2));
}
run().catch(console.error).finally(() => prisma.$disconnect());
