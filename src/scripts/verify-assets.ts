import prisma from "@config/prisma";
import dotenv from "dotenv";
dotenv.config();

async function verify() {
  console.log("Media Assets Sync Status (Gold Standard Mapping):");
  
  const syncs = await prisma.businessProfileMediaSync.findMany({
    include: {
      media: {
        select: { name: true, publicUrl: true }
      }
    },
    orderBy: { mediaId: "asc" }
  });

  console.table(syncs.map(s => ({
    id: s.id,
    assetId: s.mediaId,
    name: s.media.name,
    platform: s.platform,
    identifier: s.identifier,
    syncStatus: s.status,
    externalId: s.externalMediaId,
    expiresAt: s.expiresAt?.toISOString() || "N/A"
  })));

  await prisma.$disconnect();
}

verify();


