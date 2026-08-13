import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findOrderEventForProcessing: vi.fn(),
  createOrderConfirmationWorkflow: vi.fn(),
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
  sendConfirmationNotification: vi.fn(),
  sendAcknowledgementNotification: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("./orderConfirmation.repository", () => ({
  findOrderEventForProcessing: mocks.findOrderEventForProcessing,
  createOrderConfirmationWorkflow: mocks.createOrderConfirmationWorkflow,
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
}));

vi.mock("./orderConfirmation.whatsapp.adapter", () => ({
  OrderConfirmationRateLimitError: class OrderConfirmationRateLimitError extends Error {},
  OrderConfirmationGlobalKillSwitchError: class OrderConfirmationGlobalKillSwitchError extends Error {},
  OrderConfirmationSuppressedError: class OrderConfirmationSuppressedError extends Error {},
  sendConfirmationNotification: mocks.sendConfirmationNotification,
  sendAcknowledgementNotification: mocks.sendAcknowledgementNotification,
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
  });

  it("does not enqueue a second notification when the event was already processed", async () => {
    mocks.findOrderEventForProcessing.mockResolvedValue({ ...eventRecord, status: "PROCESSED" });
    mocks.createOrderConfirmationWorkflow.mockResolvedValue({ created: false });

    await processOrderEvent(101);

    expect(mocks.createOrderConfirmationWorkflow).not.toHaveBeenCalled();
    expect(mocks.enqueueNotification).not.toHaveBeenCalled();
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
      })
      .mockResolvedValueOnce({
        applied: false,
        orderId: 12,
        action: "CANCEL",
        currentStatus: "CONFIRMED",
      });
    mocks.createAcknowledgementNotification.mockResolvedValue({
      created: true,
      notification: { id: 19 },
    });
    mocks.createPendingStoreSync.mockResolvedValue({ id: 20 });

    await expect(processOrderAction(actionInput)).resolves.toMatchObject({ applied: true });
    await expect(
      processOrderAction({ ...actionInput, actionToken: "other-token", buttonTitle: "Cancel" }),
    ).resolves.toMatchObject({ applied: false, currentStatus: "CONFIRMED" });

    expect(mocks.enqueueNotification).toHaveBeenCalledTimes(1);
    expect(mocks.createPendingStoreSync).toHaveBeenCalledTimes(1);
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
