import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  syncFindUnique: vi.fn(),
  syncUpdate: vi.fn(),
  assertExternalApiUrlNetworkSafe: vi.fn(),
  decryptFacebookSecret: vi.fn((value: string) => value),
  fetch: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@config/prisma", () => ({
  default: {
    orderStoreSync: {
      findUnique: mocks.syncFindUnique,
      update: mocks.syncUpdate,
    },
  },
}));

vi.mock("@modules/integrations/external/agentActionExecutor.service", () => ({
  assertExternalApiUrlNetworkSafe: mocks.assertExternalApiUrlNetworkSafe,
}));

vi.mock("@modules/auth/core/tokenCrypto", () => ({
  decryptFacebookSecret: mocks.decryptFacebookSecret,
}));

vi.mock("@utils/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

import { computeOrderWebhookSignature } from "./orderConfirmation.crypto";
import { sendGenericOrderStatusCallback } from "./orderConfirmation.store.adapter";

const syncRecord = {
  id: 42,
  status: "PENDING",
  requestedStatus: "CONFIRMED",
  providerIdempotencyKey: "order-status:12:CONFIRMED",
  attemptCount: 0,
  order: {
    id: 12,
    externalOrderId: "external-order-12",
    status: "CONFIRMED",
    events: [{ externalEventId: "source-event-7" }],
    integration: {
      id: 7,
      isActive: true,
      storeSyncEnabled: true,
      statusCallbackUrl: "https://store.example.test/order-status",
      statusCallbackSecret: "current-secret",
      previousStatusCallbackSecret: null,
    },
  },
} as const;

function response(status: number): Response {
  return { status, ok: status >= 200 && status < 300 } as Response;
}

describe("generic signed store status callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.syncFindUnique.mockResolvedValue(syncRecord);
    mocks.syncUpdate.mockResolvedValue(undefined);
    mocks.assertExternalApiUrlNetworkSafe.mockResolvedValue(undefined);
    mocks.fetch.mockResolvedValue(response(204));
  });

  it("sends the exact signed callback body and marks a 2xx response succeeded", async () => {
    await sendGenericOrderStatusCallback(42);

    const [, options] = mocks.fetch.mock.calls[0] as [string, RequestInit];
    const timestamp = String((options.headers as Record<string, string>)["X-Wkil-Timestamp"]);
    const body = JSON.stringify({
      eventType: "order.status_changed",
      orderId: 12,
      externalOrderId: "external-order-12",
      status: "CONFIRMED",
      eventId: "source-event-7",
      idempotencyKey: "order-status:12:CONFIRMED",
    });

    expect(mocks.assertExternalApiUrlNetworkSafe).toHaveBeenCalledWith(
      "https://store.example.test/order-status",
    );
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://store.example.test/order-status",
      expect.objectContaining({
        method: "POST",
        body,
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "order-status:12:CONFIRMED",
          "X-Wkil-Timestamp": timestamp,
          "X-Wkil-Signature": computeOrderWebhookSignature(
            timestamp,
            Buffer.from(body),
            "current-secret",
          ),
        },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(mocks.syncUpdate).toHaveBeenLastCalledWith({
      where: { id: 42 },
      data: expect.objectContaining({
        status: "SUCCEEDED",
        providerStatus: "204",
        lastError: null,
        nextAttemptAt: null,
        completedAt: expect.any(Date),
      }),
    });
  });

  it("treats an already-applied 409 as success", async () => {
    mocks.fetch.mockResolvedValue(response(409));

    await expect(sendGenericOrderStatusCallback(42)).resolves.toBeUndefined();

    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.syncUpdate).toHaveBeenLastCalledWith({
      where: { id: 42 },
      data: expect.objectContaining({ status: "SUCCEEDED", providerStatus: "409" }),
    });
  });

  it.each([408, 429, 500, 503])(
    "marks HTTP %s as pending and lets BullMQ retry it",
    async (status) => {
      mocks.fetch.mockResolvedValue(response(status));

      await expect(sendGenericOrderStatusCallback(42)).rejects.toThrow(
        `Store status callback returned HTTP ${status}`,
      );

      expect(mocks.syncUpdate).toHaveBeenLastCalledWith({
        where: { id: 42 },
        data: expect.objectContaining({
          status: "PENDING",
          providerStatus: String(status),
          lastError: `Store status callback returned HTTP ${status}`,
          nextAttemptAt: expect.any(Date),
        }),
      });
    },
  );

  it("rejects malformed or DNS-unsafe callback URLs before network access", async () => {
    mocks.syncFindUnique.mockResolvedValueOnce({
      ...syncRecord,
      order: {
        ...syncRecord.order,
        integration: {
          ...syncRecord.order.integration,
          statusCallbackUrl: "not-a-url",
        },
      },
    });

    await expect(sendGenericOrderStatusCallback(42)).resolves.toBeUndefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.syncUpdate).toHaveBeenLastCalledWith({
      where: { id: 42 },
      data: expect.objectContaining({ status: "FAILED" }),
    });

    vi.clearAllMocks();
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.syncFindUnique.mockResolvedValue({
      ...syncRecord,
      order: {
        ...syncRecord.order,
        integration: {
          ...syncRecord.order.integration,
          statusCallbackUrl: "https://127.0.0.1/order-status",
        },
      },
    });
    mocks.syncUpdate.mockResolvedValue(undefined);
    mocks.assertExternalApiUrlNetworkSafe.mockRejectedValue(new Error("private address"));

    await expect(sendGenericOrderStatusCallback(42)).resolves.toBeUndefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.syncUpdate).toHaveBeenLastCalledWith({
      where: { id: 42 },
      data: expect.objectContaining({ status: "FAILED" }),
    });
  });

  it("rejects non-HTTPS callback URLs before DNS or network access", async () => {
    mocks.syncFindUnique.mockResolvedValue({
      ...syncRecord,
      order: {
        ...syncRecord.order,
        integration: {
          ...syncRecord.order.integration,
          statusCallbackUrl: "http://store.example.test/order-status",
        },
      },
    });

    await expect(sendGenericOrderStatusCallback(42)).resolves.toBeUndefined();

    expect(mocks.assertExternalApiUrlNetworkSafe).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.syncUpdate).toHaveBeenLastCalledWith({
      where: { id: 42 },
      data: expect.objectContaining({ status: "FAILED" }),
    });
  });

  it.each([
    "getaddrinfo EAI_AGAIN store.example.test",
    "connect ETIMEDOUT store.example.test",
    "read ECONNRESET store.example.test",
  ])("keeps transient DNS/network preflight error %s pending", async (message) => {
    mocks.assertExternalApiUrlNetworkSafe.mockRejectedValue(new Error(message));

    await expect(sendGenericOrderStatusCallback(42)).rejects.toThrow(
      "Store status callback network request failed",
    );

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.syncUpdate).toHaveBeenLastCalledWith({
      where: { id: 42 },
      data: expect.objectContaining({ status: "PENDING", nextAttemptAt: expect.any(Date) }),
    });
  });

  it("marks timeout and network failures pending for retry", async () => {
    mocks.fetch.mockRejectedValue(new DOMException("The operation was aborted", "AbortError"));

    await expect(sendGenericOrderStatusCallback(42)).rejects.toThrow(
      "Store status callback network request failed",
    );

    expect(mocks.syncUpdate).toHaveBeenLastCalledWith({
      where: { id: 42 },
      data: expect.objectContaining({ status: "PENDING", nextAttemptAt: expect.any(Date) }),
    });
  });

  it("cancels the callback response body before completing the request", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    mocks.fetch.mockResolvedValue({ ...response(204), body: { cancel } } as unknown as Response);

    await sendGenericOrderStatusCallback(42);

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 422])(
    "marks permanent HTTP %s failures failed without retry",
    async (status) => {
      mocks.fetch.mockResolvedValue(response(status));

      await expect(sendGenericOrderStatusCallback(42)).resolves.toBeUndefined();

      expect(mocks.fetch).toHaveBeenCalledTimes(1);
      expect(mocks.syncUpdate).toHaveBeenLastCalledWith({
        where: { id: 42 },
        data: expect.objectContaining({ status: "FAILED", providerStatus: String(status) }),
      });
    },
  );

  it("tries the current callback secret before the previous rotated secret", async () => {
    mocks.syncFindUnique.mockResolvedValue({
      ...syncRecord,
      order: {
        ...syncRecord.order,
        integration: {
          ...syncRecord.order.integration,
          previousStatusCallbackSecret: "previous-secret",
        },
      },
    });
    mocks.fetch
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200));

    await sendGenericOrderStatusCallback(42);

    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const firstOptions = mocks.fetch.mock.calls[0]?.[1] as RequestInit;
    const secondOptions = mocks.fetch.mock.calls[1]?.[1] as RequestInit;
    const firstHeaders = firstOptions.headers as Record<string, string>;
    const secondHeaders = secondOptions.headers as Record<string, string>;
    expect(firstHeaders["X-Wkil-Signature"]).toBe(
      computeOrderWebhookSignature(
        firstHeaders["X-Wkil-Timestamp"],
        Buffer.from(String(firstOptions.body)),
        "current-secret",
      ),
    );
    expect(secondHeaders["X-Wkil-Signature"]).toBe(
      computeOrderWebhookSignature(
        secondHeaders["X-Wkil-Timestamp"],
        Buffer.from(String(secondOptions.body)),
        "previous-secret",
      ),
    );
    expect(firstHeaders["X-Wkil-Timestamp"]).toBe(secondHeaders["X-Wkil-Timestamp"]);
    expect(mocks.syncUpdate).toHaveBeenLastCalledWith({
      where: { id: 42 },
      data: expect.objectContaining({ status: "SUCCEEDED", providerStatus: "200" }),
    });
  });
});
