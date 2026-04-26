
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const messages = await prisma.conversationMessage.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      conversationId: true,
      role: true,
      content: true,
      status: true,
      aiReasoning: true,
      createdAt: true
    }
  });
  console.log(JSON.stringify(messages, null, 2));
}

main()
  .catch(e => console.error(e))
  .finally(async () => await prisma.$disconnect());
