import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  add: vi.fn(),
  queue: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
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
  Worker: class MockWorker {},
  QueueEvents: class MockQueueEvents {},
  Job: class MockJob {},
}));

vi.mock("@config/redis", () => ({
  bullConnection: { host: "redis.test", port: 6379 },
  bullQueuePrefix: "test-prefix",
}));

vi.mock("@utils/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    error: mocks.loggerError,
    warn: mocks.loggerWarn,
  },
}));

vi.mock("@modules/meta/core/metaProcessor.service", () => ({
  processMetaMessage: vi.fn(),
  processVisualJob: vi.fn(),
}));

vi.mock("@modules/media/services/mediaLibrary.service", () => ({
  registerAssetWithMeta: vi.fn(),
}));

import { enqueueMetaJob } from "./meta.queue";

describe("Meta queue failure logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs only a safe summary when an order action enqueue fails", async () => {
    const rawActionToken = "opaque-action-token-that-must-not-be-logged";
    const rawMessageBody = `button body ${rawActionToken}`;
    const rawAccessToken = "access-token-that-must-not-be-logged";
    mocks.add.mockRejectedValueOnce(new Error("queue unavailable"));

    await expect(
      enqueueMetaJob({
        platform: "whatsapp",
        identifier: "phone-number-id",
        phoneNumberId: "phone-number-id",
        businessProfileId: 11,
        externalId: "wamid-action-failure-1",
        type: "ORDER_ACTION",
        orderActionId: rawActionToken,
        actionToken: rawActionToken,
        messageText: rawMessageBody,
        accessToken: rawAccessToken,
      }),
    ).rejects.toThrow("queue unavailable");

    expect(mocks.loggerError).toHaveBeenCalledWith("meta.queue.add_failed", {
      error: "queue unavailable",
      summary: {
        platform: "whatsapp",
        type: "ORDER_ACTION",
        identifier: "phone-number-id",
        phoneNumberId: "phone-number-id",
        businessProfileId: 11,
        externalId: "wamid-action-failure-1",
      },
    });
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(rawActionToken);
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(rawMessageBody);
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(rawAccessToken);
    expect(mocks.loggerError.mock.calls[0]?.[1]).not.toHaveProperty("payload");
  });
});
