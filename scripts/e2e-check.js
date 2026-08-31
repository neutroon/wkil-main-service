const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
p.businessProfile.findUnique({ where: { id: 1 }, select: { tone: true, voice: true } })
  .then((r) => { console.log(JSON.stringify(r)); })
  .finally(() => p.$disconnect());
