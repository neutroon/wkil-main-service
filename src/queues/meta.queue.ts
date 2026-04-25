import { Queue, Worker, Job } from "bullmq";
import { bullConnection } from "../config/redis";
import { logger } from "../utils/logger";

import {
  processMetaMessage,
  processVisualJob,
} from "../services/meta/metaProcessor.service";
import { registerAssetWithMeta } from "../services/media/mediaLibrary.service";

/**
 * Enterprise-Grade Meta Engine Queues.
 * Divided into lanes to ensure "Instant" messages aren't stuck behind "Slow" AI generation.
 */

// EXPRESS LANE: For Messenger, WhatsApp, and Webhooks (< 1s)
export const metaExpressQueue = new Queue("meta-express", {
  connection: bullConnection,
  defaultJobOptions: {
    // removeOnComplete: { count: 1000, age: 24 * 3600 }, // Keep last 1000 jobs or 24h for audit
    removeOnComplete: { count: 10 }, // Keep last 1000 jobs or 24h for audit
    // removeOnFail: { count: 5000 }, // Keep failed jobs for manual cleaning
    removeOnFail: { count: 50 }, // Keep failed jobs for manual cleaning
    attempts: 2,
  },
});

// PRODUCTION LANE: For Gemini Image Generation and AI Branding (20-60s)
export const metaProductionQueue = new Queue("meta-production", {
  connection: bullConnection,
  defaultJobOptions: {
    // removeOnComplete: { count: 500, age: 48 * 3600 }, // Keep last 500 jobs or 48h
    // removeOnFail: { count: 1000 },
    removeOnComplete: { count: 10 }, // Keep last 500 jobs or 48h
    removeOnFail: { count: 50 },
    attempts: 1,
  },
});

export type MetaJobType =
  | "messaging"
  | "visual_production"
  | "media_sync"
  | "media_refresh_scanner"
  | "status_update"
  | "typing_indicator";

export interface MetaEngineJob {
  type: MetaJobType;
  payload: any;
}

/**
 * Enqueues a job into the appropriate BullMQ lane.
 */
export async function enqueueMetaJob(job: any): Promise<void> {
  const { delaySeconds = 0, ...payload } = job;

  const isVisual =
    payload.type === "visual_production" || payload.type === "visual_refine";
  const queue = isVisual ? metaProductionQueue : metaExpressQueue;

  try {
    await queue.add(
      isVisual ? "visual_task" : "message_task",
      { type: isVisual ? "visual_production" : "messaging", payload },
      { delay: delaySeconds * 1000 },
    );
    logger.info("meta.queue.enqueued", {
      type: isVisual ? "visual" : "messaging",
      platform: payload.platform,
      delaySeconds,
    });
  } catch (err: any) {
    logger.error("meta.queue.add_failed", { error: err.message, payload });
    throw err;
  }
}

/** Legacy & Specialized Aliases */
export async function enqueueWhatsAppJob(job: any): Promise<void> {
  await enqueueMetaJob({
    ...job,
    platform: "whatsapp",
    identifier: job.phoneNumberId,
    senderId: job.from,
  });
}

export async function enqueueMessengerJob(job: any): Promise<void> {
  await enqueueMetaJob({
    ...job,
    platform: "messenger",
    identifier: job.pageId,
    senderId: job.senderId,
  });
}

export async function enqueueMediaSyncJob(assetId: number) {
  await metaExpressQueue.add("media_sync", {
    type: "media_sync",
    payload: { assetId },
  });
}

/**
 * WORKER: Express Lane
 * High concurrency (8) for fast messaging.
 */
export const expressWorker = new Worker(
  "meta-express",
  async (job: Job<MetaEngineJob>) => {
    const { type, payload } = job.data;
    logger.info("meta.engine.worker_start.express", {
      jobId: job.id,
      type,
      platform: payload.platform,
    });

    if (type === "media_sync") {
      await registerAssetWithMeta(payload.assetId);
    } else if (type === "media_refresh_scanner") {
      const { processMediaRefresh } = await import("../jobs/mediaRefresh.job");
      await processMediaRefresh();
    } else {
      await processMetaMessage(payload);
    }
  },
  { connection: bullConnection, concurrency: 8 },
);

/**
 * WORKER: Production Lane
 * Lower concurrency (2) to manage AI quota and heavy loads.
 */
export const productionWorker = new Worker(
  "meta-production",
  async (job: Job<MetaEngineJob>) => {
    await processVisualJob(job.data.payload);
  },
  { connection: bullConnection, concurrency: 2 },
);

// Recovery / Bootstrap logic (Optional now that we use Redis persistence)
// Workers are initialized but we define a start function to ensure they are "touched" and logging
export function startMetaQueue() {
  logger.info("meta.engine.initializing_workers...");

  expressWorker.on("error", (err) =>
    logger.error("meta.engine.worker_error.express", { error: err.message }),
  );
  expressWorker.on("completed", (job) =>
    logger.info("meta.engine.job_completed.express", { jobId: job.id }),
  );

  productionWorker.on("error", (err) =>
    logger.error("meta.engine.worker_error.production", { error: err.message }),
  );
  productionWorker.on("completed", (job) =>
    logger.info("meta.engine.job_completed.production", { jobId: job.id }),
  );

  logger.info("meta.engine.workers_online", {
    expressConcurrency: 8,
    productionConcurrency: 2,
  });
}
