import prisma from "../config/prisma";
import { logger } from "../utils/logger";
import dotenv from "dotenv";
dotenv.config();

async function migrate() {
  logger.info("migration.media_mappings.started");

  try {
    const assets = await prisma.businessProfileMedia.findMany({
      include: {
        businessProfile: {
          include: {
            whatsAppAccounts: { where: { isActive: true }, take: 1 },
            facebookPages: { where: { isActive: true }, take: 1 },
          },
        },
      },
    });

    logger.info("migration.media_mappings.found_assets", { count: assets.length });

    let migratedWhatsapp = 0;
    let migratedMessenger = 0;

    for (const asset of assets) {
      // 1. Migrate WhatsApp
      if (asset.whatsappMediaId && asset.businessProfile.whatsAppAccounts.length > 0) {
        const phoneId = asset.businessProfile.whatsAppAccounts[0].phoneNumberId;
        await prisma.businessProfileMediaSync.upsert({
          where: {
            mediaId_platform_identifier: {
              mediaId: asset.id,
              platform: "whatsapp",
              identifier: phoneId,
            },
          },
          update: {
            externalMediaId: asset.whatsappMediaId,
            expiresAt: asset.whatsappMediaExpiresAt,
            status: "SYNCED",
          },
          create: {
            mediaId: asset.id,
            platform: "whatsapp",
            identifier: phoneId,
            externalMediaId: asset.whatsappMediaId,
            expiresAt: asset.whatsappMediaExpiresAt,
            status: "SYNCED",
          },
        });
        migratedWhatsapp++;
      }

      // 2. Migrate Messenger
      if (asset.messengerAttachmentId && asset.businessProfile.facebookPages.length > 0) {
        const pageId = asset.businessProfile.facebookPages[0].pageId;
        await prisma.businessProfileMediaSync.upsert({
          where: {
            mediaId_platform_identifier: {
              mediaId: asset.id,
              platform: "messenger",
              identifier: pageId,
            },
          },
          update: {
            externalMediaId: asset.messengerAttachmentId,
            status: "SYNCED",
          },
          create: {
            mediaId: asset.id,
            platform: "messenger",
            identifier: pageId,
            externalMediaId: asset.messengerAttachmentId,
            status: "SYNCED",
          },
        });
        migratedMessenger++;
      }
    }

    logger.info("migration.media_mappings.completed", {
      whatsapp: migratedWhatsapp,
      messenger: migratedMessenger,
    });
  } catch (err: any) {
    logger.error("migration.media_mappings.failed", { error: err.message });
  } finally {
    await prisma.$disconnect();
  }
}

migrate();
