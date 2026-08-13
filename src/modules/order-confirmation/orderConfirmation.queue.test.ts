import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  queue: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Queue: class MockQueue {
    constructor(name: string, options: unknown) {
      mocks.queue(name, options);
    }

    add(...args: unknown[]) {
      return mocks.add(...args);
    }
  },
}));

vi.mock("@config/redis", () => ({
  bullConnection: { host: "redis.test", port: 6379 },
  bullQueuePrefix: "test-prefix",
}));

vi.mock("@modules/auth/core/tokenCrypto", () => ({
  encryptFacebookSecret: vi.fn((value: string) => `enc:${value}`),
}));

vi.mock("@utils/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
  },
}));

import {
  createOrderConfirmationJobId,
  enqueueNotification,
  enqueueOrderAction,
  enqueueOrderEvent,
  enqueueStoreSync,
  orderConfirmationQueue,
} from "./orderConfirmation.queue";
import { hashOrderActionToken } from "./orderConfirmation.crypto";

const actionInput = {
  businessProfileId: 7,
  phoneNumberId: "phone-1",
  customerPhone: "+201001234567",
  actionToken: "opaque/action.token?with=secrets",
  inboundMessageId: "wamid-123",
  buttonTitle: "Confirm",
  correlationId: "corr-action",
} as const;

const actionJob = {
  type: "PROCESS_ACTION",
  businessProfileId: actionInput.businessProfileId,
  phoneNumberId: actionInput.phoneNumberId,
  customerPhone: actionInput.customerPhone,
  encryptedActionToken: `enc:${actionInput.actionToken}`,
  actionTokenDigest: hashOrderActionToken(actionInput.actionToken),
  inboundMessageId: actionInput.inboundMessageId,
  buttonTitle: actionInput.buttonTitle,
  correlationId: actionInput.correlationId,
} as const;

describe("order confirmation queue", () => {
  beforeEach(() => {
    mocks.add.mockReset();
    mocks.add.mockResolvedValue({ id: "queued-job" });
    mocks.loggerInfo.mockReset();
  });

  it("creates stable IDs for event retries", () => {
    expect(
      createOrderConfirmationJobId({
        type: "PROCESS_EVENT",
        eventId: 42,
        correlationId: "corr-1",
      }),
    ).toBe("order-process-event-42");
  });

  it("creates resource-specific IDs for notifications and store syncs", () => {
    expect(
      createOrderConfirmationJobId({
        type: "SEND_NOTIFICATION",
        notificationId: 18,
        correlationId: "corr-2",
      }),
    ).toBe("order-send-notification-18");

    expect(
      createOrderConfirmationJobId({
        type: "SYNC_STORE",
        syncId: 23,
        correlationId: "corr-3",
      }),
    ).toBe("order-sync-store-23");
  });

  it("creates a deterministic action ID without exposing the action token", () => {
    const jobId = createOrderConfirmationJobId(actionJob);

    expect(jobId).toContain("order-process-action");
    expect(jobId).toContain("wamid-123");
    expect(jobId).not.toContain(actionInput.actionToken);
    expect(createOrderConfirmationJobId(actionJob)).toBe(jobId);
  });

  it("keeps legacy action jobs deterministic without putting their raw token in the job ID", () => {
    const legacyJob = { type: "PROCESS_ACTION", ...actionInput } as const;
    const jobId = createOrderConfirmationJobId(legacyJob);

    expect(jobId).toContain(hashOrderActionToken(actionInput.actionToken).slice(0, 24));
    expect(jobId).not.toContain(actionInput.actionToken);
  });

  it("uses the dedicated queue and durable retry defaults", () => {
    expect(mocks.queue).toHaveBeenCalledWith(
      "order-confirmations",
      expect.objectContaining({
        connection: { host: "redis.test", port: 6379 },
        prefix: "test-prefix",
        defaultJobOptions: expect.objectContaining({
          attempts: 5,
          backoff: expect.objectContaining({ type: "exponential" }),
          removeOnComplete: expect.objectContaining({ count: expect.any(Number) }),
          removeOnFail: expect.objectContaining({ count: expect.any(Number) }),
        }),
      }),
    );

    const queueOptions = mocks.queue.mock.calls[0]?.[1] as {
      defaultJobOptions: {
        removeOnComplete: { count: number };
        removeOnFail: { count: number };
      };
    };

    expect(queueOptions.defaultJobOptions.removeOnComplete.count).toBeGreaterThanOrEqual(100);
    expect(queueOptions.defaultJobOptions.removeOnFail.count).toBeGreaterThanOrEqual(500);
    expect(orderConfirmationQueue).toBeDefined();
  });

  it("enqueues event jobs with their deterministic ID", async () => {
    await enqueueOrderEvent(42, "corr-1");

    expect(mocks.add).toHaveBeenCalledWith(
      "process_event",
      { type: "PROCESS_EVENT", eventId: 42, correlationId: "corr-1" },
      { jobId: "order-process-event-42" },
    );
  });

  it("enqueues notification jobs with their deterministic ID", async () => {
    await enqueueNotification(18, "corr-2");

    expect(mocks.add).toHaveBeenCalledWith(
      "send_notification",
      { type: "SEND_NOTIFICATION", notificationId: 18, correlationId: "corr-2" },
      { jobId: "order-send-notification-18" },
    );
  });

  it("enqueues action jobs without putting their token in log metadata", async () => {
    await enqueueOrderAction(actionInput);

    expect(mocks.add).toHaveBeenCalledWith(
      "process_action",
      actionJob,
      { jobId: expect.stringContaining("order-process-action") },
    );
    expect(mocks.loggerInfo).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.loggerInfo.mock.calls)).not.toContain(actionInput.actionToken);
    expect(mocks.loggerInfo.mock.calls[0]?.[1]).not.toHaveProperty("actionToken");
    expect(mocks.add.mock.calls[0]?.[1]).not.toHaveProperty("actionToken");
  });

  it("enqueues store sync jobs with their deterministic ID", async () => {
    await enqueueStoreSync(23, "corr-3");

    expect(mocks.add).toHaveBeenCalledWith(
      "sync_store",
      { type: "SYNC_STORE", syncId: 23, correlationId: "corr-3" },
      { jobId: "order-sync-store-23" },
    );
  });
});
