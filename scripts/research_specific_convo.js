const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const commentId = '856694447323244_1129003066954289';
  const convo = await prisma.conversation.findFirst({
    where: { externalId: commentId },
    include: {
      businessProfile: true,
      messages: { take: 5, orderBy: { createdAt: 'desc' } }
    }
  });

  console.log('--- CONVERSATION DATA ---');
  console.dir(convo, { depth: null });

  const page = await prisma.facebookPage.findFirst({
    where: { pageId: '113571781631445' }
  });
  console.log('--- TARGET PAGE DATA ---');
  console.dir(page, { depth: null });
}

main().catch(console.error).finally(() => prisma.$disconnect());
