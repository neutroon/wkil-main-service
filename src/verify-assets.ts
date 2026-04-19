import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const assets = await prisma.businessProfileMedia.findMany({
    where: { isActive: true, deletedAt: null },
    select: {
      id: true,
      name: true,
      whatsappSyncStatus: true,
      messengerSyncStatus: true,
      whatsappMediaId: true,
      messengerAttachmentId: true,
      publicUrl: true
    }
  });

  console.log("Media Assets Sync Status:");
  console.table(assets);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
