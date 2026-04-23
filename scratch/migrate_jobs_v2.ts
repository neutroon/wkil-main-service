import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const jobs = await prisma.metaJob.findMany({
    where: { platform: 'messenger', status: 'pending' },
    take: 10
  });
  
  let productionCount = 0;
  let refineCount = 0;

  for (const job of jobs) {
    const payload = job.payload as any;
    if (payload.type === 'visual_production') {
      await prisma.metaJob.update({ where: { id: job.id }, data: { platform: 'visual_production' } });
      productionCount++;
    } else if (payload.type === 'visual_refine') {
      await prisma.metaJob.update({ where: { id: job.id }, data: { platform: 'visual_refine' } });
      refineCount++;
    }
  }

  console.log(`Updated ${productionCount} visual_production jobs and ${refineCount} visual_refine jobs.`);
}
main().catch(console.error).finally(() => prisma.$disconnect());
