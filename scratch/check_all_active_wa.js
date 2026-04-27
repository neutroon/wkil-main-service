const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const accounts = await prisma.whatsAppAccount.findMany({
    where: { isActive: true },
    select: { id: true, userId: true, businessProfileId: true, phoneNumberId: true }
  });
  console.log(JSON.stringify(accounts, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
