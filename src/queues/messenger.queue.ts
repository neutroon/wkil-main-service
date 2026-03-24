import { handleMessengerMessage } from "../services/meta/messenger.service";
import { logger } from "../utils/logger";

type MessengerJob = {
  pageId: string;
  senderId: string;
  messageText: string;
};

const queue: MessengerJob[] = [];
let draining = false;

/**
 * In-process FIFO queue so the HTTP handler can return 200 to Meta immediately
 * without awaiting LLM + Send API (reduces risk of slow-handler side effects).
 */
export function enqueueMessengerJob(job: MessengerJob): void {
  queue.push(job);
  if (!draining) void drainQueue();
}

async function drainQueue(): Promise<void> {
  draining = true;
  while (queue.length > 0) {
    const job = queue.shift()!;
    try {
      await handleMessengerMessage(
        job.pageId,
        job.senderId,
        job.messageText,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("messenger.queue.job_failed", {
        pageId: job.pageId,
        senderId: job.senderId,
        error: message,
      });
    }
  }
  draining = false;
}
