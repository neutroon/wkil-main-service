const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.whatsAppAccount.update({
    where: { id: 1 }, // Record for User 3 (nbilha161@gmail.com)
    data: { 
      isActive: true,
      businessProfileId: 1 // Link to the user's main profile
    }
  });
  console.log("Success! WhatsApp is now ACTIVE for User 3 (nbilha161@gmail.com):", result.displayPhoneNumber);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
