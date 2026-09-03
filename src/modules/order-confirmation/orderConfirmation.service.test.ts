import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOrderEventForProcessing: vi.fn(),
  createOrderConfirmationWorkflow: vi.fn(),
  markOrderEventProcessed: vi.fn(),
  markOrderEventRecoverable: vi.fn(),
  claimOrderAction: vi.fn(),
  createAcknowledgementNotification: vi.fn(),
  createPendingStoreSync: vi.fn(),
  findNotificationForSending: vi.fn(),
  markNotificationSending: vi.fn(),
  markNotificationSent: vi.fn(),
  markNotificationFailed: vi.fn(),
  markNotificationQueued: vi.fn(),
  normalizeCanonicalOrderEvent: vi.fn(),
  issueOrderActionToken: vi.fn(),
  enqueueNotification: vi.fn(),
  enqueueStoreSync: vi.fn(),
  sendConfirmationNotification: vi.fn(),
  sendAcknowledgementNotification: vi.fn(),
  sendGenericOrderStatusCallback: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("./orderConfirmation.repository", () => ({
  findOrderEventForProcessing: mocks.findOrderEventForProcessing,
  createOrderConfirmationWorkflow: mocks.createOrderConfirmationWorkflow,
  markOrderEventProcessed: mocks.markOrderEventProcessed,
  markOrderEventRecoverable: mocks.markOrderEventRecoverable,
  claimOrderAction: mocks.claimOrderAction,
  createAcknowledgementNotification: mocks.createAcknowledgementNotification,
  createPendingStoreSync: mocks.createPendingStoreSync,
  findNotificationForSending: mocks.findNotificationForSending,
  markNotificationSending: mocks.markNotificationSending,
  markNotificationSent: mocks.markNotificationSent,
  markNotificationFailed: mocks.markNotificationFailed,
  markNotificationQueued: mocks.markNotificationQueued,
}));

vi.mock("./orderConfirmation.normalizer", () => ({
  normalizeCanonicalOrderEvent: mocks.normalizeCanonicalOrderEvent,
}));

vi.mock("./orderConfirmation.crypto", () => ({
  issueOrderActionToken: mocks.issueOrderActionToken,
}));

vi.mock("./orderConfirmation.queue", () => ({
  enqueueNotification: mocks.enqueueNotification,
  enqueueStoreSync: mocks.enqueueStoreSync,
}));

vi.mock("./orderConfirmation.whatsapp.adapter", () => ({
  OrderConfirmationRateLimitError: class OrderConfirmationRateLimitError extends Error {},
  OrderConfirmationAmbiguousDeliveryError: class OrderConfirmationAmbiguousDeliveryError extends Error {},
  OrderConfirmationGlobalKillSwitchError: class OrderConfirmationGlobalKillSwitchError extends Error {},
  OrderConfirmationSuppressedError: class OrderConfirmationSuppressedError extends Error {},
  sendConfirmationNotification: mocks.sendConfirmationNotification,
  sendAcknowledgementNotification: mocks.sendAcknowledgementNotification,
}));

vi.mock("./orderConfirmation.store.adapter", () => ({
  sendGenericOrderStatusCallback: mocks.sendGenericOrderStatusCallback,
}));

vi.mock("@utils/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

import {
  processOrderAction,
  processOrderEvent,
  processStoreSync,
  sendOrderNotification,
} from "./orderConfirmation.service";

const canonicalEvent = {
  schemaVersion: "1",
  eventId: "evt-1",
  eventType: "order.created",
  occurredAt: "2026-08-13T10:30:00.000Z",
  order: {
    id: "order-1",
    number: "#1",
    currency: "USD",
    total: "10.00",
    customer: { name: "Mona", phone: "+12025550123", locale: "en" },
  },
} as const;

const eventRecord = {
  id: 101,
  status: "RECEIVED",
  rawPayload: canonicalEvent,
  externalEventId: "evt-1",
  integrationId: 7,
  businessProfileId: 11,
  integration: {
    id: 7,
    businessProfileId: 11,
    defaultLocale: "en",
    storeSyncEnabled: true,
  },
};

const actionInput = {
  businessProfileId: 11,
  phoneNumberId: "phone-1",
  customerPhone: "+12025550123",
  actionToken: "opaque-action-token",
  inboundMessageId: "wamid-1",
  buttonTitle: "Confirm",
  correlationId: "corr-1",
} as const;

describe("order confirmation workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.normalizeCanonicalOrderEvent.mockReturnValue(canonicalEvent);
    mocks.issueOrderActionToken
      .mockReturnValueOnce({ token: "raw-confirm-token", tokenHash: "hash-confirm" })
      .mockReturnValueOnce({ token: "raw-cancel-token", tokenHash: "hash-cancel" });
    mocks.createOrderConfirmationWorkflow.mockResolvedValue({
      created: true,
      order: { id: 12, status: "AWAITING_CONFIRMATION" },
      notification: { id: 18 },
    });
    mocks.enqueueNotification.mockResolvedValue(undefined);
    mocks.enqueueStoreSync.mockResolvedValue(undefined);
    mocks.createPendingStoreSync.mockResolvedValue({ id: 20 });
    mocks.markOrderEventProcessed.mockResolvedValue(undefined);
    mocks.markNotificationSending.mockResolvedValue(true);
    mocks.markNotificationSent.mockResolvedValue(undefined);
  });

  it("creates one confirmation workflow with only action-token hashes persisted", async () => {
    mocks.findOrderEventForProcessing.mockResolvedValue(eventRecord);

    await processOrderEvent(101);

    expect(mocks.createOrderConfirmationWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 101,
        confirmTokenHash: "hash-confirm",
        cancelTokenHash: "hash-cancel",
      }),
    );
    expect(JSON.stringify(mocks.createOrderConfirmationWorkflow.mock.calls)).not.toContain(
      "raw-confirm-token",
    );
    expect(JSON.stringify(mocks.createOrderConfirmationWorkflow.mock.calls)).not.toContain(
      "raw-cancel-token",
    );
    expect(mocks.enqueueNotification).toHaveBeenCalledWith(18, expect.any(String));
    expect(mocks.markOrderEventProcessed).toHaveBeenCalledWith(101, 12);
  });

  it("does not enqueue a second notification when the event was already processed", async () => {
    mocks.findOrderEventForProcessing.mockResolvedValue({ ...eventRecord, status: "PROCESSED" });
    mocks.createOrderConfirmationWorkflow.mockResolvedValue({ created: false });

    await processOrderEvent(101);

    expect(mocks.createOrderConfirmationWorkflow).not.toHaveBeenCalled();
    expect(mocks.enqueueNotification).not.toHaveBeenCalled();
  });

  it("re-enqueues an existing queued notification when event recovery is requested", async () => {
    mocks.findOrderEventForProcessing.mockResolvedValue(eventRecord);
    mocks.createOrderConfirmationWorkflow.mockResolvedValue({
      created: false,
      shouldEnqueueNotification: true,
      order: { id: 12, status: "AWAITING_CONFIRMATION" },
      notification: { id: 18 },
    });

    await processOrderEvent(101);

    expect(mocks.enqueueNotification).toHaveBeenCalledWith(18, expect.any(String));
    expect(mocks.markOrderEventProcessed).toHaveBeenCalledWith(101, 12);
  });

  it("leaves the event recoverable when notification enqueue fails", async () => {
    mocks.findOrderEventForProcessing.mockResolvedValue(eventRecord);
    mocks.enqueueNotification.mockRejectedValueOnce(new Error("queue unavailable"));

    await expect(processOrderEvent(101)).rejects.toThrow("queue unavailable");

    expect(mocks.markOrderEventRecoverable).toHaveBeenCalledWith(
      101,
      "queue unavailable",
    );
    expect(mocks.markOrderEventProcessed).not.toHaveBeenCalled();
  });

  it("lets only the first action transition the order and enqueue an acknowledgement", async () => {
    mocks.claimOrderAction
      .mockResolvedValueOnce({
        applied: true,
        orderId: 12,
        action: "CONFIRM",
        currentStatus: "CONFIRMED",
        businessProfileId: 11,
        locale: "en",
        storeSyncEnabled: true,
        acknowledgement: { id: 19, status: "QUEUED", attemptCount: 0 },
        shouldEnqueueAcknowledgement: true,
      })
      .mockResolvedValueOnce({
        applied: false,
        orderId: 12,
        action: "CANCEL",
        currentStatus: "CONFIRMED",
        acknowledgement: { id: 19, status: "SENT", attemptCount: 1 },
        shouldEnqueueAcknowledgement: false,
      });

    await expect(processOrderAction(actionInput)).resolves.toMatchObject({ applied: true });
    await expect(
      processOrderAction({ ...actionInput, actionToken: "other-token", buttonTitle: "Cancel" }),
    ).resolves.toMatchObject({ applied: false, currentStatus: "CONFIRMED" });

    expect(mocks.enqueueNotification).toHaveBeenCalledTimes(1);
    expect(mocks.createAcknowledgementNotification).not.toHaveBeenCalled();
    expect(mocks.createPendingStoreSync).toHaveBeenCalledWith(12, 11, "CONFIRMED");
    expect(mocks.enqueueStoreSync).toHaveBeenCalledWith(20, "corr-1");
  });

  it("re-enqueues an existing sync for an already-applied action without another acknowledgement", async () => {
    mocks.claimOrderAction.mockResolvedValue({
      applied: false,
      orderId: 12,
      action: "CONFIRM",
      currentStatus: "CONFIRMED",
      businessProfileId: 11,
      storeSyncEnabled: true,
      acknowledgement: { id: 19, status: "SENT", attemptCount: 1 },
      shouldEnqueueAcknowledgement: false,
    });

    await processOrderAction(actionInput);

    expect(mocks.createPendingStoreSync).toHaveBeenCalledWith(12, 11, "CONFIRMED");
    expect(mocks.enqueueStoreSync).toHaveBeenCalledWith(20, "corr-1");
    expect(mocks.enqueueNotification).not.toHaveBeenCalled();
  });

  it("re-enqueues an existing acknowledgement after the first enqueue fails", async () => {
    mocks.claimOrderAction
      .mockResolvedValueOnce({
        applied: true,
        orderId: 12,
        action: "CONFIRM",
        currentStatus: "CONFIRMED",
        businessProfileId: 11,
        locale: "en",
        acknowledgement: { id: 19, status: "QUEUED", attemptCount: 0 },
        shouldEnqueueAcknowledgement: true,
      })
      .mockResolvedValueOnce({
        applied: false,
        orderId: 12,
        action: "CONFIRM",
        currentStatus: "CONFIRMED",
        businessProfileId: 11,
        acknowledgement: { id: 19, status: "QUEUED", attemptCount: 0 },
        shouldEnqueueAcknowledgement: true,
      });
    mocks.enqueueNotification
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce(undefined);

    await expect(processOrderAction(actionInput)).rejects.toThrow("queue unavailable");
    await expect(processOrderAction(actionInput)).resolves.toMatchObject({
      applied: false,
      currentStatus: "CONFIRMED",
    });

    expect(mocks.enqueueNotification).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueNotification).toHaveBeenNthCalledWith(1, 19, "corr-1");
    expect(mocks.enqueueNotification).toHaveBeenNthCalledWith(2, 19, "corr-1");
  });

  it("marks a notification SENDING before the provider call and SENT after success", async () => {
    mocks.findNotificationForSending.mockResolvedValue({
      id: 18,
      status: "QUEUED",
      kind: "CONFIRMATION_REQUEST",
    });
    mocks.sendConfirmationNotification.mockResolvedValue({
      providerMessageId: "wamid-outbound-1",
      previewText: "Order #1",
    });

    await sendOrderNotification(18);

    expect(mocks.markNotificationSending).toHaveBeenCalledWith(18);
    expect(mocks.markNotificationSent).toHaveBeenCalledWith(18, "wamid-outbound-1");
    expect(
      mocks.markNotificationSending.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.sendConfirmationNotification.mock.invocationCallOrder[0]);
  });

  it("marks provider failures FAILED without mutating order state", async () => {
    mocks.findNotificationForSending.mockResolvedValue({
      id: 18,
      status: "QUEUED",
      kind: "CONFIRMATION_REQUEST",
    });
    mocks.sendConfirmationNotification.mockRejectedValue(new Error("Meta unavailable"));

    await expect(sendOrderNotification(18)).rejects.toThrow("Meta unavailable");

    expect(mocks.markNotificationFailed).toHaveBeenCalledWith(18, "Meta unavailable");
    expect(mocks.claimOrderAction).not.toHaveBeenCalled();
  });

  it("quarantines ambiguous provider delivery without an automatic retry", async () => {
    mocks.findNotificationForSending.mockResolvedValue({
      id: 18,
      status: "QUEUED",
      kind: "CONFIRMATION_REQUEST",
    });
    mocks.sendConfirmationNotification.mockRejectedValue({
      code: "AMBIGUOUS_PROVIDER_DELIVERY",
    });

    await expect(sendOrderNotification(18)).resolves.toBeUndefined();

    expect(mocks.markNotificationFailed).toHaveBeenCalledWith(
      18,
      "AMBIGUOUS_PROVIDER_DELIVERY",
    );
    expect(mocks.markNotificationQueued).not.toHaveBeenCalled();
  });

  it("processes a store sync without changing the local order state", async () => {
    mocks.sendGenericOrderStatusCallback.mockResolvedValue(undefined);

    await processStoreSync(20);

    expect(mocks.sendGenericOrderStatusCallback).toHaveBeenCalledWith(20);
  });

  it("does not automatically claim an ambiguous provider delivery", async () => {
    mocks.findNotificationForSending.mockResolvedValue({
      id: 18,
      status: "FAILED",
      lastError: "AMBIGUOUS_PROVIDER_DELIVERY",
      kind: "CONFIRMATION_REQUEST",
    });
    mocks.markNotificationSending.mockResolvedValue(false);

    await sendOrderNotification(18);

    expect(mocks.markNotificationSending).toHaveBeenCalledWith(18);
    expect(mocks.sendConfirmationNotification).not.toHaveBeenCalled();
  });

  it("records suppression and global kill-switch failures without calling Meta", async () => {
    mocks.findNotificationForSending
      .mockResolvedValueOnce({ id: 18, status: "QUEUED", kind: "CONFIRMATION_REQUEST" })
      .mockResolvedValueOnce({ id: 19, status: "QUEUED", kind: "CONFIRMATION_REQUEST" });
    mocks.sendConfirmationNotification
      .mockRejectedValueOnce({ code: "WHATSAPP_SUPPRESSED", message: "customer opted out" })
      .mockRejectedValueOnce({ code: "GLOBAL_KILL_SWITCH", message: "GLOBAL_KILL_SWITCH" });

    await expect(sendOrderNotification(18)).resolves.toBeUndefined();
    await expect(sendOrderNotification(19)).resolves.toBeUndefined();

    expect(mocks.sendConfirmationNotification).toHaveBeenCalledTimes(2);
    expect(mocks.markNotificationFailed).toHaveBeenNthCalledWith(
      1,
      18,
      "customer opted out",
    );
    expect(mocks.markNotificationFailed).toHaveBeenNthCalledWith(2, 19, "GLOBAL_KILL_SWITCH");
  });
});
