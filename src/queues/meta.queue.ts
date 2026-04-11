import { MetaMessageJob, processMetaMessage } from "../services/meta/metaProcessor.service";
import { logger } from "../utils/logger";

const queue: MetaMessageJob[] = [];
let draining = false;

/**
 * Unified, Resilient FIFO Queue for Meta Platforms (Messenger & WhatsApp).
 * 
 * DESIGN GOAL: Zero Blocking.
 * If one job hangs or crashes, the processor MUST reset and pick up the next job.
 */
export function enqueueMetaJob(job: MetaMessageJob): void {
  queue.push(job);
  if (!draining) void drainQueue();
}

/** Legacy alias to support existing WhatsApp route code if needed */
export function enqueueWhatsAppJob(job: any): void {
  enqueueMetaJob({ 
    ...job, 
    platform: "whatsapp", 
    identifier: job.phoneNumberId, 
    senderId: job.from 
  });
}

/** Legacy alias to support existing Messenger route code */
export function enqueueMessengerJob(job: any): void {
  enqueueMetaJob({ 
    ...job, 
    platform: "messenger", 
    identifier: job.pageId, 
    senderId: job.senderId 
  });
}

async function drainQueue(): Promise<void> {
  // ATOMIC LOCK
  if (draining) return;
  draining = true;

  try {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) break;

      try {
        logger.info("meta.queue.processing_job", { 
          platform: job.platform, 
          senderId: job.senderId, 
          queueRemaining: queue.length 
        });

        // SAFETY: Job-level timeout of 60 seconds.
        // If an operation takes longer than 60s, we "abandon" it to keep the queue moving.
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Job Processing Timeout (60s)")), 60000)
        );

        await Promise.race([
          processMetaMessage(job),
          timeoutPromise
        ]);

      } catch (jobErr: any) {
        logger.error("meta.queue.individual_job_failed", { 
          platform: job.platform, 
          senderId: job.senderId, 
          error: jobErr.message 
        });
        // We do NOT stop the loop. We move to the next job.
      }
    }
  } catch (criticalErr: any) {
    logger.error("meta.queue.critical_worker_error", { error: criticalErr.message });
  } finally {
    // CRITICAL: Always reset the lock so the worker can restart on the next enqueue.
    draining = false;
    
    // Safety check: if things were added while we were in finally or if loop broke unexpectedly
    if (queue.length > 0) {
       void drainQueue();
    }
  }
}
