import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function run() {
  const jobs = await prisma.metaJob.findMany({ 
      where: { platform: 'messenger', payload: { path: ['type'], equals: 'FACEBOOK_COMMENT_PUBLIC_REPLY' } },
      orderBy: { createdAt: 'desc' }, 
      take: 5 
  });
  console.log(JSON.stringify(jobs, null, 2));
}
run().catch(console.error).finally(() => prisma.$disconnect());
