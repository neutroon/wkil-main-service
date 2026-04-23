import { Queue, Worker, Job } from "bullmq";
import { bullConnection } from "../config/redis";
import { logger } from "../utils/logger";
import prisma from "../config/prisma";
import { processMetaMessage, processVisualJob } from "../services/meta/metaProcessor.service";
import { registerAssetWithMeta } from "../services/media/mediaLibrary.service";

/**
 * Enterprise-Grade Meta Engine Queues.
 * Divided into lanes to ensure "Instant" messages aren't stuck behind "Slow" AI generation.
 */

// EXPRESS LANE: For Messenger, WhatsApp, and Webhooks (< 1s)
export const metaExpressQueue = new Queue("meta-express", { 
  connection: bullConnection,
  defaultJobOptions: { removeOnComplete: true, attempts: 2 }
});

// PRODUCTION LANE: For Gemini Image Generation and AI Branding (20-60s)
export const metaProductionQueue = new Queue("meta-production", { 
  connection: bullConnection,
  defaultJobOptions: { removeOnComplete: true, attempts: 1 }
});

export type MetaJobType = "messaging" | "visual_production" | "media_sync";

export interface MetaEngineJob {
  type: MetaJobType;
  payload: any;
}

/**
 * Enqueues a job into the appropriate BullMQ lane.
 */
export async function enqueueMetaJob(
  payload: any,
  delaySeconds: number = 0,
): Promise<void> {
  const isVisual = payload.type === "visual_production" || payload.type === "visual_refine";
  const queue = isVisual ? metaProductionQueue : metaExpressQueue;

  await queue.add(
    isVisual ? "visual_task" : "message_task",
    { type: isVisual ? "visual_production" : "messaging", payload },
    { delay: delaySeconds * 1000 }
  );
}

/** Legacy & Specialized Aliases */
export async function enqueueWhatsAppJob(job: any): Promise<void> {
  await enqueueMetaJob({ 
    ...job, 
    platform: "whatsapp", 
    identifier: job.phoneNumberId, 
    senderId: job.from 
  });
}

export async function enqueueMessengerJob(job: any): Promise<void> {
  await enqueueMetaJob({ 
    ...job, 
    platform: "messenger", 
    identifier: job.pageId, 
    senderId: job.senderId 
  });
}

export async function enqueueMediaSyncJob(assetId: number) {
  await metaExpressQueue.add("media_sync", { type: "media_sync", payload: { assetId } });
}

/** 
 * WORKER: Express Lane 
 * High concurrency (8) for fast messaging.
 */
export const expressWorker = new Worker(
  "meta-express",
  async (job: Job<MetaEngineJob>) => {
    const { type, payload } = job.data;
    if (type === "media_sync") {
      await registerAssetWithMeta(payload.assetId);
    } else {
      await processMetaMessage(payload);
    }
  },
  { connection: bullConnection, concurrency: 8 }
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
  { connection: bullConnection, concurrency: 2 }
);

// Recovery / Bootstrap logic (Optional now that we use Redis persistence)
export async function bootstrapMetaQueue() {
  logger.info("meta.engine.bullmq_initialized");
}

export function startMetaQueue() {
  // BullMQ workers start automatically on initialization
  logger.info("meta.engine.workers_online");
}
