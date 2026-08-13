import * as Sentry from "@sentry/node";
import { Job, Worker } from "bullmq";
import { bullConnection, bullQueuePrefix } from "@config/redis";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { logger } from "@utils/logger";
import {
  clearExpiredOrderEventPayloads,
  findStaleOrderEvents,
  findStaleOrderNotifications,
  findUnattemptedQueuedOrderNotifications,
  markStaleSendingNotificationsFailed,
} from "./orderConfirmation.repository";
import { enqueueNotification, enqueueOrderEvent } from "./orderConfirmation.queue";
import {
  processOrderAction,
  processOrderEvent,
  sendOrderNotification,
} from "./orderConfirmation.service";
import type { OrderConfirmationJob } from "./orderConfirmation.types";

const RECOVERY_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 60_000;

function jobCorrelationId(job: Job<OrderConfirmationJob>): string {
  return job.data.correlationId;
}

function failureCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function processOrderConfirmationJob(
  job: Job<OrderConfirmationJob>,
): Promise<void> {
  switch (job.data.type) {
    case "PROCESS_EVENT":
      await processOrderEvent(job.data.eventId);
      return;
    case "SEND_NOTIFICATION":
      await sendOrderNotification(job.data.notificationId);
      return;
    case "PROCESS_ACTION":
      await processOrderAction({
        businessProfileId: job.data.businessProfileId,
        phoneNumberId: job.data.phoneNumberId,
        customerPhone: job.data.customerPhone,
        inboundMessageId: job.data.inboundMessageId,
        buttonTitle: job.data.buttonTitle,
        correlationId: job.data.correlationId,
        actionToken: decryptFacebookSecret(job.data.encryptedActionToken),
      });
      return;
  }
}

export const orderConfirmationWorker = new Worker<OrderConfirmationJob>(
  "order-confirmations",
  async (job) => {
    try {
      await processOrderConfirmationJob(job);
    } catch (error) {
      const correlationId = jobCorrelationId(job);
      logger.error("order_confirmation.worker_job_failed", {
        correlationId,
        jobId: job.id,
        type: job.data.type,
        error: error instanceof Error ? error.message : String(error),
      });
      Sentry.captureException(error, {
        tags: {
          order_confirmation_job_type: job.data.type,
          order_confirmation_correlation_id: correlationId,
        },
        extra: { jobId: job.id },
      });

      if (failureCode(error) === "ORDER_CONFIRMATION_RATE_LIMIT") {
        const retryAfterMs = Number((error as { retryAfterMs?: unknown }).retryAfterMs);
        if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
          await orderConfirmationWorker.rateLimit(retryAfterMs);
          throw Worker.RateLimitError();
        }
      }

      throw error;
    }
  },
  { connection: bullConnection, prefix: bullQueuePrefix, concurrency: 4 },
);

export async function runOrderConfirmationRecoveryScan(now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
  const [events, staleSendingNotifications, queuedNotifications] = await Promise.all([
    findStaleOrderEvents(cutoff),
    findStaleOrderNotifications(cutoff),
    findUnattemptedQueuedOrderNotifications(cutoff),
  ]);

  await markStaleSendingNotificationsFailed(cutoff);

  for (const event of events) {
    try {
      await enqueueOrderEvent(event.id, `order-recovery-event-${event.id}`);
    } catch (error) {
      logger.error("order_confirmation.recovery_event_enqueue_failed", {
        correlationId: `order-recovery-event-${event.id}`,
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const notification of queuedNotifications) {
    try {
      await enqueueNotification(notification.id, `order-recovery-notification-${notification.id}`);
    } catch (error) {
      logger.error("order_confirmation.recovery_notification_enqueue_failed", {
        correlationId: `order-recovery-notification-${notification.id}`,
        notificationId: notification.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (staleSendingNotifications.length > 0) {
    logger.warn("order_confirmation.recovery_sending_marked_ambiguous", {
      correlationId: "order-confirmation-recovery",
      notificationCount: staleSendingNotifications.length,
    });
  }

  try {
    await clearExpiredOrderEventPayloads(now);
  } catch (error) {
    logger.error("order_confirmation.recovery_payload_cleanup_failed", {
      correlationId: "order-recovery-payload-cleanup",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

let orderConfirmationQueueStarted = false;
let recoveryTimer: NodeJS.Timeout | undefined;

export function startOrderConfirmationQueue(): void {
  if (orderConfirmationQueueStarted) {
    logger.warn("order_confirmation.queue.start_skipped_already_started", {
      correlationId: "order-confirmation-queue-lifecycle",
    });
    return;
  }

  orderConfirmationQueueStarted = true;

  orderConfirmationWorker.on("ready", () =>
    logger.info("order_confirmation.worker_ready", {
      correlationId: "order-confirmation-queue-lifecycle",
    }),
  );
  orderConfirmationWorker.on("active", (job) =>
    logger.debug("order_confirmation.job_active", {
      correlationId: jobCorrelationId(job),
      jobId: job.id,
      type: job.data.type,
    }),
  );
  orderConfirmationWorker.on("completed", (job) =>
    logger.debug("order_confirmation.job_completed", {
      correlationId: jobCorrelationId(job),
      jobId: job.id,
      type: job.data.type,
    }),
  );
  orderConfirmationWorker.on("failed", (job, error) =>
    logger.error("order_confirmation.job_failed", {
      correlationId: job ? jobCorrelationId(job) : "order-confirmation-unknown",
      jobId: job?.id,
      type: job?.data.type,
      error: error.message,
    }),
  );
  orderConfirmationWorker.on("stalled", (jobId) =>
    logger.warn("order_confirmation.job_stalled", {
      correlationId: "order-confirmation-recovery",
      jobId,
    }),
  );
  orderConfirmationWorker.on("error", (error) => {
    logger.error("order_confirmation.worker_error", {
      correlationId: "order-confirmation-queue-lifecycle",
      error: error.message,
    });
    Sentry.captureException(error, {
      tags: { order_confirmation_worker: "true" },
    });
  });

  recoveryTimer = setInterval(() => {
    void runOrderConfirmationRecoveryScan().catch((error) => {
      logger.error("order_confirmation.recovery_scan_failed", {
        correlationId: "order-confirmation-recovery",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, RECOVERY_INTERVAL_MS);
  recoveryTimer.unref?.();

  void runOrderConfirmationRecoveryScan().catch((error) => {
    logger.error("order_confirmation.recovery_scan_failed", {
      correlationId: "order-confirmation-recovery",
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export function stopOrderConfirmationQueue(): void {
  if (!recoveryTimer) return;
  clearInterval(recoveryTimer);
  recoveryTimer = undefined;
}
