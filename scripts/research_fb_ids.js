const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const pages = await prisma.facebookPage.findMany({
    select: {
      id: true,
      pageId: true,
      pageName: true,
      isActive: true,
      facebookAccountId: true
    }
  });
  console.log('--- FB PAGES IN DB ---');
  console.dir(pages, { depth: null });
}

main().catch(console.error).finally(() => prisma.$disconnect());
