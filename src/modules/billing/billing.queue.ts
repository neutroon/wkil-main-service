import { Queue, Worker, Job } from "bullmq";
import { bullConnection, bullQueuePrefix } from "@config/redis";
import { logger } from "@utils/logger";
import { recordAiUsage } from "./billing.service";

export type AiUsageRecordPayload = Parameters<typeof recordAiUsage>[0];

type BillingJob =
  | {
      type: "ai_usage_record";
      payload: AiUsageRecordPayload;
    };

export const billingQueue = new Queue("billing", {
  connection: bullConnection,
  prefix: bullQueuePrefix,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { count: 1_000 },
    removeOnFail: { count: 5_000 },
  },
});

function safeBillingJobId(value: string) {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 180);
}

export async function enqueueAiUsageRecord(
  payload: AiUsageRecordPayload,
  opts: { jobId?: string } = {},
) {
  const job = await billingQueue.add(
    "ai_usage_record",
    {
      type: "ai_usage_record",
      payload,
    } satisfies BillingJob,
    {
      jobId: opts.jobId ? safeBillingJobId(opts.jobId) : undefined,
    },
  );

  logger.debug("billing.queue.ai_usage_enqueued", {
    jobId: job.id,
    businessProfileId: payload.businessProfileId,
    modelName: payload.modelName,
    operation: payload.operation,
  });
}

export const billingWorker = new Worker(
  "billing",
  async (job: Job<BillingJob>) => {
    if (job.data.type === "ai_usage_record") {
      await recordAiUsage(job.data.payload);
    }
  },
  { connection: bullConnection, prefix: bullQueuePrefix, concurrency: 4 },
);

let billingQueueStarted = false;

export function startBillingQueue() {
  if (billingQueueStarted) {
    logger.warn("billing.queue.start_skipped_already_started");
    return;
  }
  billingQueueStarted = true;

  billingWorker.on("ready", () => logger.info("billing.worker_ready"));
  billingWorker.on("active", (job) =>
    logger.debug("billing.job_active", { jobId: job.id, name: job.name }),
  );
  billingWorker.on("completed", (job) =>
    logger.debug("billing.job_completed", { jobId: job.id, name: job.name }),
  );
  billingWorker.on("failed", (job, err) =>
    logger.error("billing.job_failed", {
      jobId: job?.id,
      name: job?.name,
      error: err.message,
    }),
  );
  billingWorker.on("error", (err) =>
    logger.error("billing.worker_error", { error: err.message }),
  );
}
