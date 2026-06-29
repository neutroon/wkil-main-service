import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@config/prisma", () => ({
  default: {
    conversation: {
      findUnique: vi.fn(),
    },
    conversationMessage: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@modules/notifications/deviceToken.service", () => ({
  deleteDeviceTokens: vi.fn(),
  listActiveTokensForBusiness: vi.fn(),
}));

vi.mock("@modules/notifications/fcm.service", () => ({
  sendMulticast: vi.fn(),
}));

vi.mock("@utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import prisma from "@config/prisma";
import { deleteDeviceTokens, listActiveTokensForBusiness } from "@modules/notifications/deviceToken.service";
import { sendMulticast } from "@modules/notifications/fcm.service";
import { buildConversationUid, sendHandoffPush } from "./handoffPush.service";

const mockedPrisma = prisma as unknown as {
  conversation: { findUnique: ReturnType<typeof vi.fn> };
  conversationMessage: { findFirst: ReturnType<typeof vi.fn> };
};
const mockedList = listActiveTokensForBusiness as ReturnType<typeof vi.fn>;
const mockedSend = sendMulticast as ReturnType<typeof vi.fn>;
const mockedCleanup = deleteDeviceTokens as ReturnType<typeof vi.fn>;

describe("buildConversationUid", () => {
  it("joins channel and id with a dash, matching the mobile-side helper", () => {
    expect(buildConversationUid("whatsapp", 123)).toBe("whatsapp-123");
    expect(buildConversationUid("messenger", 7)).toBe("messenger-7");
    expect(buildConversationUid("facebook_comment", 42)).toBe(
      "facebook_comment-42",
    );
  });
});

describe("sendHandoffPush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: two active devices, conversation exists, last customer
    // message is a short Arabic string.
    mockedList.mockResolvedValue(["token-A", "token-B"]);
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      channel: "whatsapp",
    });
    mockedPrisma.conversationMessage.findFirst.mockResolvedValue({
      content: "محتاج اسعار المنتجات",
    });
    mockedSend.mockResolvedValue({
      attempted: 2,
      successCount: 2,
      failureCount: 0,
      deadTokens: [],
    });
  });

  it("no-ops (no FCM call) when the business has no registered devices", async () => {
    mockedList.mockResolvedValueOnce([]);
    await sendHandoffPush({
      businessProfileId: 1,
      conversationId: 99,
      handoffCategory: "SALES",
      locale: "en",
    });
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("sends the localized title + truncated preview body to every active token", async () => {
    await sendHandoffPush({
      businessProfileId: 1,
      conversationId: 99,
      handoffCategory: "SALES",
      locale: "ar",
    });
    expect(mockedSend).toHaveBeenCalledOnce();
    const msg = mockedSend.mock.calls[0]![0] as {
      tokens: string[];
      notification: { title: string; body: string };
      data: Record<string, string>;
      android: { channelId: string; priority: string };
      apns: { pushType: string; payload: { aps: { sound: string } } };
    };
    expect(msg.tokens).toEqual(["token-A", "token-B"]);
    expect(msg.notification.title).toBe("طلب تسليم بشري");
    expect(msg.notification.body).toBe("محتاج اسعار المنتجات");
    expect(msg.data).toMatchObject({
      type: "handoff_request",
      conversation_id: "99",
      conversation_uid: "whatsapp-99",
      business_id: "1",
      handoff_category: "SALES",
      locale: "ar",
    });
    expect(msg.android.channelId).toBe("handoff_requests");
    expect(msg.android.priority).toBe("high");
    expect(msg.apns.pushType).toBe("alert");
  });

  it("falls back to the default body when there's no customer preview", async () => {
    mockedPrisma.conversationMessage.findFirst.mockResolvedValueOnce(null);
    await sendHandoffPush({
      businessProfileId: 1,
      conversationId: 99,
      handoffCategory: "COMPLAINT",
      locale: "en",
    });
    const msg = mockedSend.mock.calls[0]![0] as {
      notification: { title: string; body: string };
    };
    expect(msg.notification.title).toBe("Handoff requested");
    expect(msg.notification.body).toBe("Customer needs a human");
  });

  it("truncates the preview to fit OS notification body limits", async () => {
    const huge = "x".repeat(500);
    mockedPrisma.conversationMessage.findFirst.mockResolvedValueOnce({
      content: huge,
    });
    await sendHandoffPush({
      businessProfileId: 1,
      conversationId: 99,
      handoffCategory: "SALES",
      locale: "en",
    });
    const msg = mockedSend.mock.calls[0]![0] as {
      notification: { body: string };
    };
    // 119 chars + ellipsis = 120 chars total
    expect(msg.notification.body.length).toBe(120);
    expect(msg.notification.body.endsWith("…")).toBe(true);
  });

  it("uses 'web' as the default channel when the conversation has none", async () => {
    mockedPrisma.conversation.findUnique.mockResolvedValueOnce({ channel: null });
    await sendHandoffPush({
      businessProfileId: 1,
      conversationId: 50,
      handoffCategory: "OTHER",
      locale: "en",
    });
    const msg = mockedSend.mock.calls[0]![0] as { data: Record<string, string> };
    expect(msg.data.conversation_uid).toBe("web-50");
  });

  it("garbage-collects tokens FCM reported as dead", async () => {
    mockedSend.mockResolvedValueOnce({
      attempted: 2,
      successCount: 1,
      failureCount: 1,
      deadTokens: ["token-A"],
    });
    await sendHandoffPush({
      businessProfileId: 1,
      conversationId: 99,
      handoffCategory: "SALES",
      locale: "en",
    });
    expect(mockedCleanup).toHaveBeenCalledWith(["token-A"]);
  });

  it("swallows cleanup failures (push fan-out must not affect the handoff decision)", async () => {
    mockedSend.mockResolvedValueOnce({
      attempted: 2,
      successCount: 1,
      failureCount: 1,
      deadTokens: ["token-A"],
    });
    mockedCleanup.mockRejectedValueOnce(new Error("db is down"));
    await expect(
      sendHandoffPush({
        businessProfileId: 1,
        conversationId: 99,
        handoffCategory: "SALES",
        locale: "en",
      }),
    ).resolves.toBeUndefined();
  });

  it("never throws — a missing conversation is logged, not raised", async () => {
    mockedPrisma.conversation.findUnique.mockResolvedValueOnce(null);
    await expect(
      sendHandoffPush({
        businessProfileId: 1,
        conversationId: 999999,
        handoffCategory: "SALES",
        locale: "en",
      }),
    ).resolves.toBeUndefined();
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it("never throws — FCM outage is logged, not raised", async () => {
    mockedSend.mockRejectedValueOnce(new Error("FCM 503"));
    await expect(
      sendHandoffPush({
        businessProfileId: 1,
        conversationId: 99,
        handoffCategory: "SALES",
        locale: "en",
      }),
    ).resolves.toBeUndefined();
  });
});
