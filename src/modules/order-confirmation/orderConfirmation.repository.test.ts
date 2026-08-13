import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  create: vi.fn(),
  findActionToken: vi.fn(),
  transaction: vi.fn(),
  txOrderUpdateMany: vi.fn(),
  txOrderFindUnique: vi.fn(),
  txActionTokenUpdateMany: vi.fn(),
  txStoreSyncUpsert: vi.fn(),
  txAcknowledgementUpsert: vi.fn(),
  notificationUpdateMany: vi.fn(),
  notificationUpdate: vi.fn(),
  notificationFindMany: vi.fn(),
  conversationMessageFindUnique: vi.fn(),
  storeSyncFindMany: vi.fn(),
}));

vi.mock("@config/prisma", () => ({
  default: {
    orderIntegration: {
      findFirst: mocks.findFirst,
    },
    orderEvent: {
      create: mocks.create,
    },
    orderActionToken: {
      findFirst: mocks.findActionToken,
    },
    orderNotification: {
      findMany: mocks.notificationFindMany,
      updateMany: mocks.notificationUpdateMany,
      update: mocks.notificationUpdate,
    },
    conversationMessage: {
      findUnique: mocks.conversationMessageFindUnique,
    },
    orderStoreSync: {
      findMany: mocks.storeSyncFindMany,
    },
    $transaction: mocks.transaction,
  },
}));

import {
  claimOrderAction,
  findActiveIntegrationByPublicKey,
  insertOrderEventIfNew,
  markNotificationSending,
  markNotificationSent,
  markStaleSendingNotificationsFailed,
  findPendingOrderStoreSyncs,
  findUnattemptedQueuedOrderNotifications,
  requeueNotificationForRetry,
} from "./orderConfirmation.repository";
import { hashOrderActionToken } from "./orderConfirmation.crypto";

const eventParams = {
  integrationId: 7,
  businessProfileId: 11,
  externalEventId: "evt_123",
  eventType: "order.created",
  schemaVersion: "1",
  occurredAt: new Date("2026-08-13T10:30:00.000Z"),
  rawPayload: {
    schemaVersion: "1",
    eventId: "evt_123",
    eventType: "order.created",
    occurredAt: "2026-08-13T10:30:00.000Z",
    order: {
      id: "ord_123",
      number: "#123",
      currency: "USD",
      total: "10.00",
      customer: { phone: "+12025550123" },
    },
  },
} as const;

describe("order confirmation repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.txOrderUpdateMany.mockResolvedValue({ count: 1 });
    mocks.txOrderFindUnique.mockResolvedValue({ status: "CONFIRMED" });
    mocks.txActionTokenUpdateMany.mockResolvedValue({ count: 1 });
    mocks.txStoreSyncUpsert.mockResolvedValue({ id: 20 });
    mocks.txAcknowledgementUpsert.mockResolvedValue({
      id: 19,
      status: "QUEUED",
      attemptCount: 0,
    });
    mocks.notificationUpdateMany.mockResolvedValue({ count: 1 });
    mocks.notificationUpdate.mockResolvedValue(undefined);
    mocks.notificationFindMany.mockResolvedValue([]);
    mocks.conversationMessageFindUnique.mockResolvedValue({ id: 88 });
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({
        order: {
          updateMany: mocks.txOrderUpdateMany,
          findUnique: mocks.txOrderFindUnique,
        },
        orderActionToken: { updateMany: mocks.txActionTokenUpdateMany },
        orderStoreSync: { upsert: mocks.txStoreSyncUpsert },
        orderNotification: { upsert: mocks.txAcknowledgementUpsert },
      }),
    );
  });

  it("selects only verification fields for an active integration", async () => {
    const integration = {
      id: 7,
      businessProfileId: 11,
      signingSecret: "enc:v1:encrypted-secret",
      previousSigningSecret: "enc:v1:previous-secret",
      isActive: true,
    };
    mocks.findFirst.mockResolvedValue(integration);

    await expect(findActiveIntegrationByPublicKey("public-key")).resolves.toEqual(
      integration,
    );

    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { integrationKey: "public-key", isActive: true },
      select: {
        id: true,
        businessProfileId: true,
        signingSecret: true,
        previousSigningSecret: true,
        isActive: true,
      },
    });
  });

  it("persists a received immutable event without returning secrets", async () => {
    const created = { id: 101, ...eventParams };
    mocks.create.mockResolvedValue(created);

    const result = await insertOrderEventIfNew(eventParams);

    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        integrationId: 7,
        businessProfileId: 11,
        externalEventId: "evt_123",
        eventType: "order.created",
        schemaVersion: "1",
        occurredAt: eventParams.occurredAt,
        rawPayload: eventParams.rawPayload,
        status: "RECEIVED",
      },
    });
    expect(result).toEqual({ duplicate: false, event: { id: 101 } });
    expect(result).not.toHaveProperty("signingSecret");
    expect(JSON.stringify(result)).not.toContain("enc:v1:");
  });

  it("returns a duplicate result for the event composite unique conflict", async () => {
    mocks.create.mockRejectedValue({ code: "P2002", meta: { target: ["integrationId", "externalEventId"] } });

    await expect(insertOrderEventIfNew(eventParams)).resolves.toEqual({
      duplicate: true,
    });
  });

  it("hashes action input and creates sync before acknowledgement in one transaction", async () => {
    mocks.findActionToken.mockResolvedValue({
      id: 30,
      action: "CONFIRM",
      order: {
        id: 12,
        status: "AWAITING_CONFIRMATION",
        businessProfileId: 11,
        locale: "en",
        integration: { storeSyncEnabled: true },
      },
    });

    const result = await claimOrderAction({
      businessProfileId: 11,
      phoneNumberId: "phone-1",
      customerPhone: "+12025550123",
      actionToken: "raw-action-token",
    });

    expect(mocks.findActionToken.mock.calls[0]?.[0].where).toEqual(
      expect.objectContaining({
        businessProfileId: 11,
        tokenHash: hashOrderActionToken("raw-action-token"),
      }),
    );
    expect(JSON.stringify(mocks.findActionToken.mock.calls)).not.toContain(
      "raw-action-token",
    );
    expect(mocks.txStoreSyncUpsert.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.txAcknowledgementUpsert.mock.invocationCallOrder[0],
    );
    expect(result).toMatchObject({
      applied: true,
      acknowledgement: { id: 19, status: "QUEUED", attemptCount: 0 },
      shouldEnqueueAcknowledgement: true,
    });
  });

  it("rolls back the order follow-up when pending sync creation fails", async () => {
    mocks.findActionToken.mockResolvedValue({
      id: 30,
      action: "CONFIRM",
      order: {
        id: 12,
        status: "AWAITING_CONFIRMATION",
        businessProfileId: 11,
        locale: "en",
        integration: { storeSyncEnabled: true },
      },
    });
    mocks.txStoreSyncUpsert.mockRejectedValue(new Error("sync unavailable"));

    await expect(
      claimOrderAction({
        businessProfileId: 11,
        phoneNumberId: "phone-1",
        customerPhone: "+12025550123",
        actionToken: "raw-action-token",
      }),
    ).rejects.toThrow("sync unavailable");
    expect(mocks.txAcknowledgementUpsert).not.toHaveBeenCalled();
  });

  it("marks stale sends ambiguous and clears failure fields on a successful retry", async () => {
    const cutoff = new Date("2026-08-13T09:59:00.000Z");

    await markStaleSendingNotificationsFailed(cutoff);
    expect(mocks.notificationUpdateMany).toHaveBeenCalledWith({
      where: { status: "SENDING", updatedAt: { lt: cutoff } },
      data: {
        status: "FAILED",
        failedAt: expect.any(Date),
        lastError: "AMBIGUOUS_PROVIDER_DELIVERY",
      },
    });

    await markNotificationSending(18);
    expect(mocks.notificationUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 18,
        OR: [
          { status: "QUEUED" },
          { status: "FAILED", lastError: null },
          {
            status: "FAILED",
            lastError: { not: "AMBIGUOUS_PROVIDER_DELIVERY" },
          },
        ],
      },
      data: { status: "SENDING", lastError: null, failedAt: null },
    });

    await markNotificationSent(18, "wamid-18");
    expect(mocks.notificationUpdate).toHaveBeenCalledWith({
      where: { id: 18 },
      data: expect.objectContaining({
        status: "SENT",
        providerMessageId: "wamid-18",
        failedAt: null,
        lastError: null,
      }),
    });
  });

  it("keeps queued and nullable/non-ambiguous failures claimable", async () => {
    await markNotificationSending(18);

    const calls = mocks.notificationUpdateMany.mock.calls;
    const where = calls[calls.length - 1]?.[0].where as {
      OR: Array<Record<string, unknown>>;
    };
    const matches = (status: string, lastError: string | null) =>
      where.OR.some((branch) => {
        if (branch.status === "QUEUED") return status === "QUEUED";
        if (branch.status !== "FAILED" || status !== "FAILED") return false;
        if (branch.lastError === null) return lastError === null;
        return (
          typeof branch.lastError === "object" &&
          branch.lastError !== null &&
          "not" in branch.lastError &&
          lastError !== (branch.lastError as { not: string }).not
        );
      });

    expect(matches("QUEUED", null)).toBe(true);
    expect(matches("FAILED", null)).toBe(true);
    expect(matches("FAILED", "Meta unavailable")).toBe(true);
    expect(matches("FAILED", "AMBIGUOUS_PROVIDER_DELIVERY")).toBe(false);
  });

  it("finds stale pending store syncs whose retry time is due", async () => {
    const cutoff = new Date("2026-08-13T09:59:00.000Z");
    const now = new Date("2026-08-13T10:00:00.000Z");
    mocks.storeSyncFindMany.mockResolvedValue([{ id: 20 }]);

    await expect(findPendingOrderStoreSyncs(cutoff, now)).resolves.toEqual([{ id: 20 }]);

    expect(mocks.storeSyncFindMany).toHaveBeenCalledWith({
      where: {
        status: "PENDING",
        updatedAt: { lt: cutoff },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      select: { id: true },
    });
  });

  it("recovers every stale queued notification, including notifications with prior attempts", async () => {
    const cutoff = new Date("2026-08-13T09:59:00.000Z");
    mocks.notificationFindMany.mockResolvedValue([{ id: 18 }]);

    await expect(findUnattemptedQueuedOrderNotifications(cutoff)).resolves.toEqual([{ id: 18 }]);

    expect(mocks.notificationFindMany).toHaveBeenCalledWith({
      where: { status: "QUEUED", updatedAt: { lt: cutoff } },
      select: { id: true },
    });
  });

  it("requeues a confirmation only while its order is still awaiting confirmation", async () => {
    await expect(requeueNotificationForRetry(18, 11)).resolves.toBe(true);

    expect(mocks.notificationUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 18,
        businessProfileId: 11,
        status: "FAILED",
        OR: [
          {
            kind: "CONFIRMATION_REQUEST",
            order: { status: "AWAITING_CONFIRMATION" },
          },
          {
            kind: "ACKNOWLEDGEMENT",
            order: { status: { in: ["CONFIRMED", "CANCELED"] } },
          },
        ],
      },
      data: {
        status: "QUEUED",
        lastError: null,
        failedAt: null,
        queuedAt: expect.any(Date),
      },
    });
  });
});
