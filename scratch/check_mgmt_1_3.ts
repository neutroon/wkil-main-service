import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const management = await prisma.userManagement.findMany({
    where: {
      OR: [
        { managerId: 3, userId: 1 },
        { managerId: 1, userId: 3 }
      ]
    }
  });
  console.log(JSON.stringify(management, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
