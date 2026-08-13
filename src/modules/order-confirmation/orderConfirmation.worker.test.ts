import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearExpiredOrderEventPayloads: vi.fn(),
  findStaleOrderEvents: vi.fn(),
  findStaleOrderNotifications: vi.fn(),
  findUnattemptedQueuedOrderNotifications: vi.fn(),
  markStaleSendingNotificationsFailed: vi.fn(),
  enqueueOrderEvent: vi.fn(),
  enqueueNotification: vi.fn(),
  processOrderAction: vi.fn(),
  processOrderEvent: vi.fn(),
  sendOrderNotification: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerDebug: vi.fn(),
  loggerError: vi.fn(),
  captureException: vi.fn(),
  decryptFacebookSecret: vi.fn((value: string) =>
    value.startsWith("enc:") ? value.slice(4) : value,
  ),
}));

vi.mock("bullmq", () => ({
  Worker: class MockWorker extends EventEmitter {
    static RateLimitError() {
      return new Error("rate limited");
    }

    rateLimit = vi.fn();
  },
  Job: class {},
}));
vi.mock("@config/redis", () => ({
  bullConnection: {},
  bullQueuePrefix: "test",
}));
vi.mock("@sentry/node", () => ({ captureException: mocks.captureException }));
vi.mock("@modules/auth/core/tokenCrypto", () => ({
  decryptFacebookSecret: mocks.decryptFacebookSecret,
}));
vi.mock("@utils/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    debug: mocks.loggerDebug,
    error: mocks.loggerError,
  },
}));
vi.mock("./orderConfirmation.repository", () => ({
  clearExpiredOrderEventPayloads: mocks.clearExpiredOrderEventPayloads,
  findStaleOrderEvents: mocks.findStaleOrderEvents,
  findStaleOrderNotifications: mocks.findStaleOrderNotifications,
  findUnattemptedQueuedOrderNotifications: mocks.findUnattemptedQueuedOrderNotifications,
  markStaleSendingNotificationsFailed: mocks.markStaleSendingNotificationsFailed,
}));
vi.mock("./orderConfirmation.queue", () => ({
  enqueueOrderEvent: mocks.enqueueOrderEvent,
  enqueueNotification: mocks.enqueueNotification,
}));
vi.mock("./orderConfirmation.service", () => ({
  processOrderAction: mocks.processOrderAction,
  processOrderEvent: mocks.processOrderEvent,
  sendOrderNotification: mocks.sendOrderNotification,
}));

import {
  processOrderConfirmationJob,
  runOrderConfirmationRecoveryScan,
  startOrderConfirmationQueue,
  stopOrderConfirmationQueue,
} from "./orderConfirmation.worker";

describe("order confirmation recovery lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findStaleOrderEvents.mockResolvedValue([]);
    mocks.findStaleOrderNotifications.mockResolvedValue([{ id: 7 }]);
    mocks.findUnattemptedQueuedOrderNotifications.mockResolvedValue([{ id: 8 }]);
    mocks.markStaleSendingNotificationsFailed.mockResolvedValue(undefined);
    mocks.clearExpiredOrderEventPayloads.mockResolvedValue(undefined);
    mocks.enqueueOrderEvent.mockResolvedValue(undefined);
    mocks.enqueueNotification.mockResolvedValue(undefined);
  });

  it("fails stale SENDING notifications without enqueueing them and recovers only queued work", async () => {
    await runOrderConfirmationRecoveryScan(new Date("2026-08-13T10:00:00.000Z"));

    expect(mocks.markStaleSendingNotificationsFailed).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueNotification).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueNotification).toHaveBeenCalledWith(
      8,
      "order-recovery-notification-8",
    );
    expect(mocks.enqueueNotification).not.toHaveBeenCalledWith(
      7,
      expect.any(String),
    );
  });

  it("clears the recovery timer during shutdown", () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    startOrderConfirmationQueue();
    stopOrderConfirmationQueue();

    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
    vi.useRealTimers();
  });

  it("processes a legacy raw-token action job in memory", async () => {
    const legacyJob = {
      id: "legacy-job",
      data: {
        type: "PROCESS_ACTION",
        businessProfileId: 11,
        phoneNumberId: "phone-1",
        customerPhone: "+12025550123",
        actionToken: "legacy-raw-token",
        inboundMessageId: "wamid-legacy",
        buttonTitle: "Confirm",
        correlationId: "legacy-correlation",
      },
    } as any;

    await processOrderConfirmationJob(legacyJob);

    expect(mocks.processOrderAction).toHaveBeenCalledWith(
      expect.objectContaining({ actionToken: "legacy-raw-token" }),
    );
    expect(JSON.stringify(mocks.loggerInfo.mock.calls)).not.toContain("legacy-raw-token");
  });
});
