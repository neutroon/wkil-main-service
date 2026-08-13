import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import { bullConnection, bullQueuePrefix } from "@config/redis";
import { logger } from "@utils/logger";
import { encryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { hashOrderActionToken } from "./orderConfirmation.crypto";
import type { OrderActionInput, OrderConfirmationJob } from "./orderConfirmation.types";

const orderConfirmationDefaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 5_000 },
  removeOnComplete: { count: 1_000 },
  removeOnFail: { count: 5_000 },
};

export const orderConfirmationQueue = new Queue<OrderConfirmationJob>("order-confirmations", {
  connection: bullConnection,
  prefix: bullQueuePrefix,
  defaultJobOptions: orderConfirmationDefaultJobOptions,
});

function hashJobText(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function safeBullMqJobId(value: string) {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (sanitized.length > 180) {
    return `${sanitized.slice(0, 160).replace(/-$/g, "")}-${hashJobText(value)}`;
  }

  return sanitized || "job";
}

export function createOrderConfirmationJobId(job: OrderConfirmationJob): string {
  switch (job.type) {
    case "PROCESS_EVENT":
      return safeBullMqJobId(`order-process-event-${job.eventId}`);
    case "SEND_NOTIFICATION":
      return safeBullMqJobId(`order-send-notification-${job.notificationId}`);
    case "PROCESS_ACTION": {
      const actionTokenDigest =
        "actionTokenDigest" in job
          ? job.actionTokenDigest
          : hashOrderActionToken(job.actionToken);
      const inboundMessageId =
        job.inboundMessageId && !job.inboundMessageId.includes(actionTokenDigest)
          ? job.inboundMessageId
          : "action";
      return safeBullMqJobId(
        `order-process-action-${inboundMessageId}-${actionTokenDigest.slice(0, 24)}`,
      );
    }
    case "SYNC_STORE":
      return safeBullMqJobId(`order-sync-store-${job.syncId}`);
  }
}

function getJobResourceId(job: OrderConfirmationJob) {
  switch (job.type) {
    case "PROCESS_EVENT":
      return job.eventId;
    case "SEND_NOTIFICATION":
      return job.notificationId;
    case "PROCESS_ACTION":
      return job.inboundMessageId;
    case "SYNC_STORE":
      return job.syncId;
  }
}

async function enqueueOrderConfirmationJob(
  name: "process_event" | "send_notification" | "process_action" | "sync_store",
  job: OrderConfirmationJob,
): Promise<void> {
  const jobId = createOrderConfirmationJobId(job);

  await orderConfirmationQueue.add(name, job, { jobId });

  logger.info("order_confirmation.queue.enqueued", {
    type: job.type,
    jobId,
    resourceId: getJobResourceId(job),
    correlationId: job.correlationId,
    ...(job.type === "PROCESS_ACTION"
      ? {
          businessProfileId: job.businessProfileId,
          inboundMessageId: job.inboundMessageId,
        }
      : {}),
  });
}

export function enqueueOrderEvent(eventId: number, correlationId: string): Promise<void> {
  return enqueueOrderConfirmationJob("process_event", {
    type: "PROCESS_EVENT",
    eventId,
    correlationId,
  });
}

export function enqueueNotification(notificationId: number, correlationId: string): Promise<void> {
  return enqueueOrderConfirmationJob("send_notification", {
    type: "SEND_NOTIFICATION",
    notificationId,
    correlationId,
  });
}

export function enqueueOrderAction(input: OrderActionInput): Promise<void> {
  const encryptedActionToken = encryptFacebookSecret(input.actionToken);
  if (encryptedActionToken === input.actionToken) {
    return Promise.reject(
      new Error("FB_TOKEN_ENCRYPTION_KEY is required before queueing an order action"),
    );
  }

  return enqueueOrderConfirmationJob("process_action", {
    type: "PROCESS_ACTION",
    businessProfileId: input.businessProfileId,
    phoneNumberId: input.phoneNumberId,
    customerPhone: input.customerPhone,
    inboundMessageId: input.inboundMessageId,
    buttonTitle: input.buttonTitle,
    correlationId: input.correlationId,
    encryptedActionToken,
    actionTokenDigest: hashOrderActionToken(input.actionToken),
  });
}

export function enqueueStoreSync(syncId: number, correlationId: string): Promise<void> {
  return enqueueStoreSyncJob(syncId, correlationId);
}

async function enqueueStoreSyncJob(syncId: number, correlationId: string): Promise<void> {
  const job = await orderConfirmationQueue.getJob(
    createOrderConfirmationJobId({ type: "SYNC_STORE", syncId, correlationId }),
  );
  if (job) {
    const state = await job.getState();
    if (state !== "failed" && state !== "completed") {
      return;
    }
    await job.remove();
  }

  await enqueueOrderConfirmationJob("sync_store", {
    type: "SYNC_STORE",
    syncId,
    correlationId,
  });
}

export function enqueueStoreSyncRetry(syncId: number, correlationId: string): Promise<void> {
  return enqueueStoreSyncJob(syncId, correlationId);
}
