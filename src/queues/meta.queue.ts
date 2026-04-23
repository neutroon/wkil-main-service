import { MetaMessageJob, processMetaMessage } from "../services/meta/metaProcessor.service";
import { registerAssetWithMeta } from "../services/media/mediaLibrary.service";
import { logger } from "../utils/logger";
import prisma from "../config/prisma";

const EXPRESS_CONCURRENCY = 8;     // High throughput for messaging
const PRODUCTION_CONCURRENCY = 2;  // Dedicated capacity for visual production
const JOB_TIMEOUT_MS = 120000;     // 120s max for any job
const RETRY_INTERVALS = [5, 30, 300]; 

let drainingExpress = false;
let drainingProduction = false;
const ACTIVE_PROCESSING_KEYS = new Set<string>();

/**
 * Unified, Industrial-Grade Durable Queue for Meta Platforms.
 * 
 * FEATURES:
 * 1. Database-First: Jobs are persisted before processing (Zero Message Loss).
 * 2. Exponential Backoff: Failsafe retries for transient errors.
 * 3. Parallel Execution: Concurrency of 3 parallel workers.
 * 4. Recovery: Resets "hanging" jobs on startup.
 */

export async function enqueueMetaJob(
  job: MetaMessageJob,
  delaySeconds: number = 0,
): Promise<void> {
  try {
    const nextAttemptAt = new Date(Date.now() + delaySeconds * 1000);

    await prisma.metaJob.create({
      data: {
        platform: job.platform,
        identifier: job.identifier,
        senderId: job.senderId,
        payload: job as any,
        status: "pending",
        nextAttemptAt,
      },
    });

    // Kick off worker (non-blocking) - but only if it's due now
    // We check both lanes to see if either needs a kickstart
    if (!(drainingExpress && drainingProduction) && delaySeconds <= 0) void drainQueue();
  } catch (err: any) {
    logger.error("meta.queue.enqueue_failed", {
      error: err.message,
      platform: job.platform,
    });
    throw err;
  }
}


/** Legacy aliases */
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

/**
 * Enqueues a media synchronization job (Meta registration).
 */
export async function enqueueMediaSyncJob(assetId: number): Promise<void> {
  try {
    await prisma.metaJob.create({
      data: {
        platform: "media_sync",
        identifier: assetId.toString(),
        senderId: "system",
        payload: { assetId } as any,
        status: "pending",
      }
    });
    if (!(drainingExpress && drainingProduction)) void drainQueue();
  } catch (err: any) {
    logger.error("meta.queue.enqueue_media_sync_failed", { error: err.message, assetId });
    throw err;
  }
}


/**
 * INDUSTRIAL-GRADE LANE ISOLATED WORKER
 * 
 * Separates "Fast" messaging from "Slow" visual production to prevent 
 * resource starvation and maintain production-tier SLAs.
 */
async function drainLane(lane: "EXPRESS" | "PRODUCTION") {
  const isExpress = lane === "EXPRESS";
  if (isExpress && drainingExpress) return;
  if (!isExpress && drainingProduction) return;

  if (isExpress) drainingExpress = true; else drainingProduction = true;

  const concurrency = isExpress ? EXPRESS_CONCURRENCY : PRODUCTION_CONCURRENCY;
  const platforms = isExpress 
    ? ["facebook", "instagram", "linkedin", "whatsapp", "messenger", "media_sync"]
    : ["visual_production", "visual_refine"];

  try {
    while (true) {
      // 1. Fetch available jobs for this lane
      const pendingJobs = await prisma.metaJob.findMany({
        where: {
          status: { in: ["pending", "retrying"] },
          nextAttemptAt: { lte: new Date() },
          platform: { in: platforms }
        },
        orderBy: { createdAt: "asc" },
        take: concurrency,
      });

      if (pendingJobs.length === 0) break;

      const jobsToRun = pendingJobs.filter(job => {
        const key = `${job.platform}:${job.identifier}:${job.senderId}`;
        if (!ACTIVE_PROCESSING_KEYS.has(key)) {
          ACTIVE_PROCESSING_KEYS.add(key);
          return true;
        }
        return false;
      });

      if (jobsToRun.length === 0) break;

      await Promise.all(jobsToRun.map(async (jobRecord) => {
        const key = `${jobRecord.platform}:${jobRecord.identifier}:${jobRecord.senderId}`;
        try {
          await prisma.metaJob.update({
            where: { id: jobRecord.id },
            data: { status: "processing" }
          });

          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Lane ${lane} Timeout (${JOB_TIMEOUT_MS/1000}s)`)), JOB_TIMEOUT_MS)
          );

          if (jobRecord.platform === "media_sync") {
             const { assetId } = jobRecord.payload as { assetId: number };
             await Promise.race([registerAssetWithMeta(assetId), timeoutPromise]);
          } else if (lane === "PRODUCTION") {
             const { processVisualJob } = await import("../services/meta/metaProcessor.service");
             await Promise.race([processVisualJob(jobRecord.payload as any), timeoutPromise]);
          } else {
             await Promise.race([processMetaMessage(jobRecord.payload as any), timeoutPromise]);
          }

          await prisma.metaJob.update({
            where: { id: jobRecord.id },
            data: { status: "completed" }
          });

        } catch (jobErr: any) {
          const nextAttempt = jobRecord.attempts + 1;
          const maxAttempts = jobRecord.maxAttempts;

          if (nextAttempt < maxAttempts) {
            const backoffSec = RETRY_INTERVALS[nextAttempt - 1] || 300;
            await prisma.metaJob.update({
              where: { id: jobRecord.id },
              data: {
                status: "retrying",
                attempts: nextAttempt,
                lastError: jobErr.message.slice(0, 1000),
                nextAttemptAt: new Date(Date.now() + backoffSec * 1000)
              }
            });
          } else {
            // AUTO-RESET post status on permanent production failure
            const payload = jobRecord.payload as any;
            if (payload?.postId) {
              await prisma.contentPlanPost.update({
                where: { id: payload.postId },
                data: { status: "pending" }
              });
            }

            await prisma.metaJob.update({
              where: { id: jobRecord.id },
              data: { status: "failed", lastError: jobErr.message.slice(0, 1000), attempts: nextAttempt }
            });
          }
        } finally {
          ACTIVE_PROCESSING_KEYS.delete(key);
        }
      }));
    }
  } catch (err: any) {
    logger.error(`meta.queue.lane_error.${lane}`, { error: err.message });
  } finally {
    if (isExpress) drainingExpress = false; else drainingProduction = false;
  }
}

async function drainQueue() {
  await Promise.all([
    drainLane("EXPRESS"),
    drainLane("PRODUCTION")
  ]);
}

/**
 * STARTUP RECOVERY: Resets any jobs that were abandoned in "processing" state.
 */
export async function bootstrapMetaQueue() {
  const reset = await prisma.metaJob.updateMany({
    where: { status: "processing" },
    data: { status: "pending" }
  });
  if (reset.count > 0) {
    logger.info("meta.queue.recovery_bootstrapped", { count: reset.count });
    void drainQueue();
  }
}

let isPolling = false;

/**
 * Initializes the background queue loop to constantly check for scheduled jobs
 * (e.g., delayed public greetings, retries).
 */
export function startMetaQueue() {
  if (isPolling) return;
  isPolling = true;

  // Poll DB for scheduled jobs every 2.5 seconds
  setInterval(() => {
    void drainQueue();
  }, 2500);
  
  logger.info("meta.queue.background_polling_started");
}
