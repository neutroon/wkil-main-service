import cron from "node-cron";
import prisma from "../config/prisma";
import { registerAssetWithMeta } from "../services/media/mediaLibrary.service";
import { logger } from "../utils/logger";

/**
 * Daily scheduler that refreshes WhatsApp media IDs before they expire.
 * WhatsApp Cloud API media IDs expire ~30 days after upload.
 * We refresh any asset expiring within the next 5 days.
 */
export function startMediaRefreshJob() {
  // Runs every day at 03:00 UTC
  cron.schedule("0 3 * * *", async () => {
    logger.info("media.refresh_job.started");

    const fiveDaysFromNow = new Date();
    fiveDaysFromNow.setDate(fiveDaysFromNow.getDate() + 5);

    try {
      const expiring = await prisma.businessProfileMedia.findMany({
        where: {
          isActive: true,
          deletedAt: null,
          whatsappSyncStatus: "SYNCED",
          whatsappMediaExpiresAt: { lte: fiveDaysFromNow },
        },
        select: { id: true, name: true, businessProfileId: true },
      });

      if (expiring.length === 0) {
        logger.info("media.refresh_job.no_expiring_assets");
        return;
      }

      logger.info("media.refresh_job.refreshing", { count: expiring.length });

      // Mark expiring as EXPIRED before re-registration
      await prisma.businessProfileMedia.updateMany({
        where: { id: { in: expiring.map((a) => a.id) } },
        data: { whatsappSyncStatus: "EXPIRED" },
      });

      // Re-register each asset sequentially to avoid rate-limiting Meta APIs
      for (const asset of expiring) {
        try {
          await registerAssetWithMeta(asset.id);
          logger.info("media.refresh_job.asset_refreshed", { assetId: asset.id, name: asset.name });
        } catch (err: any) {
          logger.error("media.refresh_job.asset_failed", { assetId: asset.id, error: err.message });
        }
        // Small delay between registrations to respect Meta rate limits
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }

      logger.info("media.refresh_job.completed", { refreshed: expiring.length });
    } catch (err: any) {
      logger.error("media.refresh_job.fatal", { error: err.message });
    }
  });

  logger.info("media.refresh_job.scheduled", { schedule: "Daily at 03:00 UTC" });
}
