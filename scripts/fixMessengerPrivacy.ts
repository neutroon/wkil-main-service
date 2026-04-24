import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fixMessengerPrivacy() {
  console.log('--- Starting Messenger Privacy Migration ---');

  // Find all messages belonging to messenger conversations that are currently marked as public
  const count = await prisma.conversationMessage.count({
    where: {
      conversation: {
        channel: 'messenger'
      },
      isPrivate: false
    }
  });

  console.log(`Found ${count} messenger messages tagged as public.`);

  if (count === 0) {
    console.log('Nothing to update.');
    return;
  }

  const result = await prisma.conversationMessage.updateMany({
    where: {
      conversation: {
        channel: 'messenger'
      },
      isPrivate: false
    },
    data: {
      isPrivate: true
    }
  });

  console.log(`Successfully updated ${result.count} messages to isPrivate: true.`);
  console.log('--- Migration Completed ---');
}

fixMessengerPrivacy()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
