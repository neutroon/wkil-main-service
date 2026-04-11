import { handleWhatsAppMessage } from "../services/meta/whatsapp.service";
import { logger } from "../utils/logger";

type WhatsAppJob = {
  phoneNumberId: string;
  from: string;
  messageText: string;
  wamid: string;
  customerName?: string;
};

const queue: WhatsAppJob[] = [];
let draining = false;

/**
 * In-process FIFO queue so the HTTP handler can return 200 to Meta immediately
 * without awaiting LLM + Cloud API (reduces risk of slow-handler side effects).
 */
export function enqueueWhatsAppJob(job: WhatsAppJob): void {
  queue.push(job);
  if (!draining) void drainQueue();
}

async function drainQueue(): Promise<void> {
  draining = true;
  while (queue.length > 0) {
    const job = queue.shift()!;
    try {
      await handleWhatsAppMessage(
        job.phoneNumberId,
        job.from,
        job.messageText,
        job.wamid
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("whatsapp.queue.job_failed", {
        phoneNumberId: job.phoneNumberId,
        from: job.from,
        wamid: job.wamid,
        error: message,
      });
    }
  }
  draining = false;
}
