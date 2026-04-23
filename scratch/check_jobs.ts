import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const jobs = await prisma.metaJob.findMany({
    where: { status: { in: ['pending', 'processing', 'retrying'] } },
    take: 5,
    select: { id: true, platform: true, status: true, lastError: true }
  });
  console.log(JSON.stringify(jobs, null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
