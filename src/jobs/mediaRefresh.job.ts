import prisma from "../config/prisma";
import { enqueueMediaSyncJob, metaExpressQueue } from "../queues/meta.queue";
import { logger } from "../utils/logger";

/**
 * Scans for expiring media and enqueues sync jobs.
 */
export async function processMediaRefresh() {
  logger.info("media.refresh_job.started");

  const fiveDaysFromNow = new Date();
  fiveDaysFromNow.setDate(fiveDaysFromNow.getDate() + 5);

  try {
    const expiringSyncs = await prisma.businessProfileMediaSync.findMany({
      where: {
        platform: "whatsapp",
        status: "SYNCED",
        expiresAt: { lte: fiveDaysFromNow },
        media: {
          isActive: true,
          deletedAt: null,
        },
      },
      select: { mediaId: true },
    });

    // Distinct list of asset IDs that need refreshing
    const assetIds = Array.from(new Set(expiringSyncs.map((s) => s.mediaId)));

    if (assetIds.length === 0) {
      logger.info("media.refresh_job.no_expiring_assets");
      return;
    }

    logger.info("media.refresh_job.dispatching_to_queue", { assetCount: assetIds.length });

    // Mark expiring mappings as failed/pending for safety
    await prisma.businessProfileMediaSync.updateMany({
      where: {
        mediaId: { in: assetIds },
        platform: "whatsapp",
        expiresAt: { lte: fiveDaysFromNow },
      },
      data: { status: "FAILED" }, // Temporary state before re-sync
    });

    // Dispatch to durable queue for processing
    for (const assetId of assetIds) {
      try {
        await enqueueMediaSyncJob(assetId);
        logger.info("media.refresh_job.dispatched", { assetId });
      } catch (err: any) {
        logger.error("media.refresh_job.dispatch_failed", { assetId, error: err.message });
      }
    }

    logger.info("media.refresh_job.completed", { dispatched: assetIds.length });
  } catch (err: any) {
    logger.error("media.refresh_job.fatal", { error: err.message });
  }
}

/**
 * Daily scheduler that refreshes WhatsApp media IDs before they expire.
 * WhatsApp Cloud API media IDs expire ~30 days after upload.
 * We refresh any asset expiring within the next 5 days.
 */
export async function startMediaRefreshJob() {
  // Runs every day at 03:00 UTC via BullMQ repeatable jobs
  await metaExpressQueue.add(
    "media_refresh_scanner",
    { type: "media_refresh_scanner", payload: {} },
    {
      repeat: {
        pattern: "0 3 * * *",
      },
    }
  );

  logger.info("media.refresh_job.scheduled", { schedule: "Daily at 03:00 UTC (BullMQ)" });
}
