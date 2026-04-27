const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const conversations = await prisma.conversation.findMany({
    where: {
      businessProfileId: 1,
      OR: [
        { channel: 'whatsapp' },
        { channel: null }
      ]
    },
    take: 10
  });
  console.log(JSON.stringify(conversations, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
