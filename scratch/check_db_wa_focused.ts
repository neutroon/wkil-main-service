import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('--- WhatsApp Accounts ---');
  const accounts = await prisma.whatsAppAccount.findMany({
    select: {
      id: true,
      phoneNumberId: true,
      displayPhoneNumber: true,
      businessProfileId: true,
      isActive: true,
      userId: true
    }
  });
  console.log(JSON.stringify(accounts, null, 2));

  console.log('\n--- Business Profiles for Profile 9 ---');
  const bp9 = await prisma.businessProfile.findUnique({
    where: { id: 9 },
    select: { id: true, userId: true, name: true }
  });
  console.log(JSON.stringify(bp9, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
