import { handleMessengerMessage } from "../services/meta/messenger.service";
import { handleFacebookComment, FacebookCommentJob } from "../services/meta/facebookComment.service";
import { logger } from "../utils/logger";

type MessengerJob = {
  type: "MESSENGER";
  pageId: string;
  senderId: string;
  messageText?: string;
  externalId?: string;
  msgType?: string;
  mediaId?: string;
  mediaMetadata?: any;
};

type FacebookCommentQueueJob = FacebookCommentJob & {
  type: "FACEBOOK_COMMENT";
};

type MetaJob = MessengerJob | FacebookCommentQueueJob;

const queue: MetaJob[] = [];
let draining = false;

/**
 * In-process FIFO queue so the HTTP handler can return 200 to Meta immediately
 * without awaiting LLM + Send API (reduces risk of slow-handler side effects).
 */
export function enqueueMetaJob(job: MetaJob): void {
  queue.push(job);
  if (!draining) void drainQueue();
}

/** Legacy alias to prevent breaking existing code if any */
export function enqueueMessengerJob(job: Omit<MessengerJob, "type">): void {
  enqueueMetaJob({ ...job, type: "MESSENGER" });
}

async function drainQueue(): Promise<void> {
  draining = true;
  while (queue.length > 0) {
    const job = queue.shift()!;
    try {
      if (job.type === "MESSENGER") {
        await handleMessengerMessage(
          job.pageId,
          job.senderId,
          job.messageText || "",
          job.externalId,
          job.msgType,
          job.mediaId,
          job.mediaMetadata
        );
      } else if (job.type === "FACEBOOK_COMMENT") {
        await handleFacebookComment(job);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("meta.queue.job_failed", {
        type: job.type,
        pageId: job.pageId,
        senderId: job.senderId,
        error: message,
      });
    }
  }
  draining = false;
}
