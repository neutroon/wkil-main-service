const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const profile = await prisma.businessProfile.findFirst({
    include: { user: true }
  });
  if (!profile || !profile.user) {
    console.log("No business profile or user found to link widget to.");
    return;
  }

  const install = await prisma.widgetInstall.upsert({
    where: { publicSiteKey: 'wsk_test_key' },
    update: { isActive: true, businessProfileId: profile.id, userId: profile.userId },
    create: {
      publicSiteKey: 'wsk_test_key',
      businessProfileId: profile.id,
      userId: profile.userId,
      label: 'Test Widget',
      allowedOrigins: ['*'],
      isActive: true,
    }
  });

  console.log("Test widget install ready:", install.publicSiteKey);
}

main().catch(console.error).finally(() => prisma.$disconnect());
