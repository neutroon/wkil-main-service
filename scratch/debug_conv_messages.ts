
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const messages = await prisma.conversationMessage.findMany({
    where: { conversationId: 7 },
    orderBy: { createdAt: 'asc' }
  });
  console.log('Conversation ID 7 Messages:', messages.length);
  console.log(JSON.stringify(messages, null, 2));
}

main().catch(console.error);
