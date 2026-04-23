import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const jobs = await prisma.metaJob.findMany({
    where: {
      platform: 'messenger',
      payload: { path: ['type'], equals: 'visual_production' }
    },
    take: 5
  });
  console.log(JSON.stringify(jobs, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
