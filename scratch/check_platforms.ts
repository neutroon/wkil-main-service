import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const platforms = await prisma.metaJob.groupBy({
    by: ['platform'],
    _count: { id: true }
  });
  console.log(JSON.stringify(platforms, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
