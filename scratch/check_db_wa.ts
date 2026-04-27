import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('--- WhatsApp Accounts ---');
  const accounts = await prisma.whatsAppAccount.findMany({
    include: {
      businessProfile: true
    }
  });
  console.dir(accounts, { depth: null });

  console.log('\n--- WhatsApp Conversations ---');
  const conversations = await prisma.conversation.findMany({
    where: {
      OR: [
        { channel: 'whatsapp' },
        { channel: null }
      ]
    },
    take: 10
  });
  console.dir(conversations, { depth: null });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
