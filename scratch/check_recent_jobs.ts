import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
prisma.metaJob.findMany({ where: { status: { in: ['completed', 'failed'] } }, orderBy: { updatedAt: 'desc' }, take: 5 })
  .then(js => console.log(JSON.stringify(js, null, 2)))
  .finally(() => prisma.$disconnect());
