import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.metaJob.findFirst({ where: { platform: 'messenger', status: 'pending' } })
  .then(j => console.log(JSON.stringify(j?.payload, null, 2)))
  .finally(() => prisma.$disconnect());
