const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const profile = await prisma.businessProfile.findFirst({
    where: { userId: 3 }
  });
  console.log(JSON.stringify(profile, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
