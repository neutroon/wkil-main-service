import { MetaMessageJob, processMetaMessage } from "../services/meta/metaProcessor.service";
import { registerAssetWithMeta } from "../services/media/mediaLibrary.service";
import { logger } from "../utils/logger";
import prisma from "../config/prisma";

const CONCURRENCY = 3;
const JOB_TIMEOUT_MS = 60000; // 60s
const RETRY_INTERVALS = [5, 30, 300]; // seconds (5s, 30s, 5m)

let draining = false;

/**
 * Unified, Industrial-Grade Durable Queue for Meta Platforms.
 * 
 * FEATURES:
 * 1. Database-First: Jobs are persisted before processing (Zero Message Loss).
 * 2. Exponential Backoff: Failsafe retries for transient errors.
 * 3. Parallel Execution: Concurrency of 3 parallel workers.
 * 4. Recovery: Resets "hanging" jobs on startup.
 */

export async function enqueueMetaJob(job: MetaMessageJob): Promise<void> {
  try {
    await prisma.metaJob.create({
      data: {
        platform: job.platform,
        identifier: job.identifier,
        senderId: job.senderId,
        payload: job as any,
        status: "pending",
      }
    });
    
    // Kick off worker (non-blocking)
    if (!draining) void drainQueue();
  } catch (err: any) {
    logger.error("meta.queue.enqueue_failed", { error: err.message, platform: job.platform });
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
    if (!draining) void drainQueue();
  } catch (err: any) {
    logger.error("meta.queue.enqueue_media_sync_failed", { error: err.message, assetId });
    throw err;
  }
}


async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;

  try {
    while (true) {
      // 1. Fetch available jobs
      const pendingJobs = await prisma.metaJob.findMany({
        where: {
          status: { in: ["pending", "retrying"] },
          nextAttemptAt: { lte: new Date() },
        },
        orderBy: { createdAt: "asc" },
        take: CONCURRENCY,
      });

      if (pendingJobs.length === 0) break;

      // 2. Run batch in parallel
      await Promise.all(pendingJobs.map(async (jobRecord) => {
        // Mark as processing to avoid double pickup
        await prisma.metaJob.update({
          where: { id: jobRecord.id },
          data: { status: "processing" }
        });

        const jobData = jobRecord.payload as unknown as MetaMessageJob;

        try {
          logger.info("meta.queue.processing_job", { 
            id: jobRecord.id,
            platform: jobData.platform, 
            senderId: jobData.senderId,
            attempt: jobRecord.attempts + 1
          });

          // SAFETY: Job-level timeout
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Job Processing Timeout (60s)")), JOB_TIMEOUT_MS)
          );

          if (jobRecord.platform === "media_sync") {
            const { assetId } = jobRecord.payload as { assetId: number };
            await Promise.race([
              registerAssetWithMeta(assetId),
              timeoutPromise
            ]);
          } else {
            await Promise.race([
              processMetaMessage(jobData),
              timeoutPromise
            ]);
          }

          // MARK SUCCESS
          await prisma.metaJob.update({
            where: { id: jobRecord.id },
            data: { status: "completed" }
          });

        } catch (jobErr: any) {
          const nextAttempt = jobRecord.attempts + 1;
          const maxAttempts = jobRecord.maxAttempts;

          if (nextAttempt < maxAttempts) {
            const backoffSec = RETRY_INTERVALS[nextAttempt - 1] || 300;
            logger.warn("meta.queue.job_retrying", { 
              id: jobRecord.id, 
              error: jobErr.message, 
              nextAttempt,
              delaySec: backoffSec
            });

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
            logger.error("meta.queue.job_permanently_failed", { 
              id: jobRecord.id, 
              error: jobErr.message 
            });

            await prisma.metaJob.update({
              where: { id: jobRecord.id },
              data: { 
                status: "failed", 
                lastError: jobErr.message.slice(0, 1000), 
                attempts: nextAttempt 
              }
            });
          }
        }
      }));
    }
  } catch (criticalErr: any) {
    logger.error("meta.queue.critical_worker_error", { error: criticalErr.message });
  } finally {
    draining = false;
    
    // Check if new jobs arrived while finishing the last batch
    const hasMore = await prisma.metaJob.count({
      where: {
        status: { in: ["pending", "retrying"] },
        nextAttemptAt: { lte: new Date() },
      }
    });
    if (hasMore > 0) void drainQueue();
  }
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
