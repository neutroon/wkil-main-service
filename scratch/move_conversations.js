const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.conversation.updateMany({
    where: {
      pageId: '1105381092649827',
      businessProfileId: 9
    },
    data: {
      businessProfileId: 1
    }
  });
  console.log(`Successfully moved ${result.count} conversations from Profile 9 to Profile 1.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
