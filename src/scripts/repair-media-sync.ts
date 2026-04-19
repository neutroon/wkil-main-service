import dotenv from "dotenv";
dotenv.config();

import prisma from "../config/prisma";
import { registerAssetWithMeta } from "../services/media/mediaLibrary.service";
import { logger } from "../utils/logger";

async function repair() {
  logger.info("repair.media_sync.started");

  const pendingAssets = await prisma.businessProfileMedia.findMany({
    where: {
      OR: [
        { whatsappSyncStatus: "PENDING" },
        { messengerSyncStatus: "PENDING" },
        { whatsappSyncStatus: "FAILED" },
        { messengerSyncStatus: "FAILED" }
      ],
      isActive: true,
      deletedAt: null
    }
  });

  logger.info("repair.media_sync.found_assets", { count: pendingAssets.length });

  for (const asset of pendingAssets) {
    logger.info("repair.media_sync.processing_asset", { id: asset.id, name: asset.name });
    try {
      await registerAssetWithMeta(asset.id);
    } catch (err: any) {
      logger.error("repair.media_sync.asset_failed", { id: asset.id, error: err.message });
    }
  }

  logger.info("repair.media_sync.finished");
}

repair()
  .catch(err => logger.error("repair.media_sync.fatal", { error: err.message }))
  .finally(() => prisma.$disconnect());
