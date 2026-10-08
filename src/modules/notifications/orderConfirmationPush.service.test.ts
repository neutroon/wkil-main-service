import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listActiveTokensForBusiness: vi.fn(),
  deleteDeviceTokens: vi.fn(),
  sendMulticast: vi.fn(),
}));

vi.mock("./deviceToken.service", () => ({
  listActiveTokensForBusiness: mocks.listActiveTokensForBusiness,
  deleteDeviceTokens: mocks.deleteDeviceTokens,
}));

vi.mock("./fcm.service", () => ({
  sendMulticast: mocks.sendMulticast,
}));

vi.mock("@utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { sendOrderConfirmationPush } from "./orderConfirmationPush.service";

describe("sendOrderConfirmationPush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listActiveTokensForBusiness.mockResolvedValue(["fcm-token-1", "fcm-token-2"]);
    mocks.sendMulticast.mockResolvedValue({
      attempted: 2,
      successCount: 2,
      failureCount: 0,
      deadTokens: [],
    });
  });

  it.each([
    {
      status: "CONFIRMED",
      locale: "en",
      title: "Order confirmed",
      body: "A customer confirmed an order.",
    },
    {
      status: "CANCELED",
      locale: "ar",
      title: "تم إلغاء الطلب",
      body: "ألغى أحد العملاء طلبًا.",
    },
  ] as const)("sends a generic localized $status notification", async (scenario) => {
    await sendOrderConfirmationPush({
      businessProfileId: 11,
      orderId: 12,
      status: scenario.status,
      locale: scenario.locale,
    });

    expect(mocks.listActiveTokensForBusiness).toHaveBeenCalledWith({ businessProfileId: 11 });
    expect(mocks.sendMulticast).toHaveBeenCalledOnce();
    const payload = mocks.sendMulticast.mock.calls[0]![0] as {
      tokens: string[];
      notification: { title: string; body: string };
      data: Record<string, string>;
      android: { channelId: string; priority: string; visibility: string };
      apns: { pushType: string; sound: string };
    };
    expect(payload.tokens).toEqual(["fcm-token-1", "fcm-token-2"]);
    expect(payload.notification).toEqual({ title: scenario.title, body: scenario.body });
    expect(payload.data).toEqual({
      type: "order_confirmation",
      order_id: "12",
      business_id: "11",
      status: scenario.status,
    });
    expect(payload.android).toEqual({
      channelId: "order_confirmations",
      priority: "high",
      visibility: "private",
    });
    expect(payload.apns).toEqual({ pushType: "alert", sound: "default" });
    expect(JSON.stringify(payload.notification)).not.toContain("12");
    expect(JSON.stringify(payload.notification)).not.toContain("customer name");
  });

  it("does not send when the business has no active registered devices", async () => {
    mocks.listActiveTokensForBusiness.mockResolvedValueOnce([]);

    await sendOrderConfirmationPush({
      businessProfileId: 11,
      orderId: 12,
      status: "CONFIRMED",
      locale: "en",
    });

    expect(mocks.sendMulticast).not.toHaveBeenCalled();
  });

  it("removes tokens FCM reports as invalid", async () => {
    mocks.sendMulticast.mockResolvedValueOnce({
      attempted: 2,
      successCount: 1,
      failureCount: 1,
      deadTokens: ["fcm-token-2"],
    });

    await sendOrderConfirmationPush({
      businessProfileId: 11,
      orderId: 12,
      status: "CONFIRMED",
      locale: "en",
    });

    expect(mocks.deleteDeviceTokens).toHaveBeenCalledWith(["fcm-token-2"]);
  });

  it("never throws when token lookup, delivery, or cleanup fails", async () => {
    mocks.listActiveTokensForBusiness.mockRejectedValueOnce(new Error("db unavailable"));
    await expect(sendOrderConfirmationPush({
      businessProfileId: 11,
      orderId: 12,
      status: "CONFIRMED",
      locale: "en",
    })).resolves.toBeUndefined();

    mocks.sendMulticast.mockRejectedValueOnce(new Error("FCM unavailable"));
    await expect(sendOrderConfirmationPush({
      businessProfileId: 11,
      orderId: 12,
      status: "CONFIRMED",
      locale: "en",
    })).resolves.toBeUndefined();

    mocks.sendMulticast.mockResolvedValueOnce({
      attempted: 2,
      successCount: 1,
      failureCount: 1,
      deadTokens: ["fcm-token-1"],
    });
    mocks.deleteDeviceTokens.mockRejectedValueOnce(new Error("db unavailable"));
    await expect(sendOrderConfirmationPush({
      businessProfileId: 11,
      orderId: 12,
      status: "CONFIRMED",
      locale: "en",
    })).resolves.toBeUndefined();
  });
});
