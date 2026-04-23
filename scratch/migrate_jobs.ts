import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  // Update jobs that were enqueued as 'messenger' but are actually visual production/refine
  const res1 = await prisma.metaJob.updateMany({
    where: {
      platform: 'messenger',
      status: 'pending',
      payload: { path: ['type'], equals: 'visual_production' }
    },
    data: { platform: 'visual_production' }
  });
  
  const res2 = await prisma.metaJob.updateMany({
    where: {
      platform: 'messenger',
      status: 'pending',
      payload: { path: ['type'], equals: 'visual_refine' }
    },
    data: { platform: 'visual_refine' }
  });

  console.log(`Updated ${res1.count} visual_production jobs and ${res2.count} visual_refine jobs.`);
}
main().catch(console.error).finally(() => prisma.$disconnect());
