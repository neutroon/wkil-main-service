import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDelete: vi.fn(),
  whatsappAccountFindFirst: vi.fn(),
  conversationMessageFindFirst: vi.fn(),
  conversationMessageUpdate: vi.fn(),
  conversationMessageUpdateMany: vi.fn(),
  reconcileNotificationDeliveryStatus: vi.fn(),
  suppressionUpsert: vi.fn(),
  getOrCreateConversation: vi.fn(),
  saveMessage: vi.fn(),
  enqueueOrderAction: vi.fn(),
  computeBusinessChatReply: vi.fn(),
  buildUnansweredUserTurnContext: vi.fn(),
  startConversationAiRun: vi.fn(),
  createLatencyTrace: vi.fn(),
  classifyInboundMessageSignal: vi.fn(),
  loggerInfo: vi.fn(),
  loggerDebug: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  decryptFacebookSecret: vi.fn((value: string) => `decrypted:${value}`),
}));

vi.mock("bullmq", () => ({
  UnrecoverableError: class MockUnrecoverableError extends Error {},
  Queue: class MockQueue {},
  QueueEvents: class MockQueueEvents {},
  Worker: class MockWorker {},
}));

vi.mock("@config/prisma", () => ({
  default: {
    whatsAppAccount: { findFirst: mocks.whatsappAccountFindFirst },
    conversationMessage: {
      findFirst: mocks.conversationMessageFindFirst,
      update: mocks.conversationMessageUpdate,
      updateMany: mocks.conversationMessageUpdateMany,
    },
    whatsAppSuppression: { upsert: mocks.suppressionUpsert },
  },
}));

vi.mock("@config/redis", () => ({
  redisClient: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
  bullConnection: { host: "redis.test", port: 6379 },
  bullQueuePrefix: "test-prefix",
}));

vi.mock("@utils/cache", () => ({
  cache: {
    get: mocks.cacheGet,
    set: mocks.cacheSet,
    delete: mocks.cacheDelete,
  },
}));

vi.mock("@utils/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    debug: mocks.loggerDebug,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

vi.mock("@modules/auth/core/tokenCrypto", () => ({
  decryptFacebookSecret: mocks.decryptFacebookSecret,
}));

vi.mock("@modules/meta/core/conversation.service", () => ({
  getOrCreateConversation: mocks.getOrCreateConversation,
  saveMessage: mocks.saveMessage,
}));

vi.mock("@modules/order-confirmation/orderConfirmation.queue", () => ({
  enqueueOrderAction: mocks.enqueueOrderAction,
}));

vi.mock("@modules/order-confirmation/orderConfirmation.repository", () => ({
  reconcileNotificationDeliveryStatus: mocks.reconcileNotificationDeliveryStatus,
}));

vi.mock("@modules/ai-agent/chat/businessChatReply.service", () => ({
  computeBusinessChatReply: mocks.computeBusinessChatReply,
}));

vi.mock("@modules/ai-agent/chat/conversationTurnContext", () => ({
  buildUnansweredUserTurnContext: mocks.buildUnansweredUserTurnContext,
}));

vi.mock("@modules/ai-agent/chat/deliveryPolicy", () => ({
  initialCustomerReplyStatus: vi.fn(() => "SENDING"),
}));

vi.mock("@modules/ai-agent/chat/replySideEffects.service", () => ({
  notifySavedModelReplySideEffects: vi.fn(),
  scheduleFollowUpsForDeliveredReply: vi.fn(),
}));

vi.mock("@modules/meta/facebook/facebook.service", () => ({
  getFacebookUserProfile: vi.fn(),
  likeComment: vi.fn(),
}));

vi.mock("@modules/meta/core/inboundMediaUnderstanding.service", () => ({
  understandInboundMedia: vi.fn(),
}));

vi.mock("@modules/ai-agent/chat/conversationRunGuard", () => ({
  assertLatestConversationAiRun: vi.fn(),
  isStaleConversationRunError: vi.fn(() => false),
  startConversationAiRun: mocks.startConversationAiRun,
}));

vi.mock("@utils/latencyTrace", () => ({
  createLatencyTrace: mocks.createLatencyTrace,
}));

vi.mock("@modules/ai-agent/chat/messageSignals", () => ({
  classifyInboundMessageSignal: mocks.classifyInboundMessageSignal,
  buildTurnTextWithTranscript: vi.fn(({ originalText }: { originalText: string }) => originalText),
}));

import { processMetaMessage } from "@modules/meta/core/metaProcessor.service";

const account = {
  businessProfileId: 11,
  accessToken: "encrypted-account-token",
  isTokenValid: true,
  businessProfile: { agentActionSources: [] },
};

describe("WhatsApp order action routing and suppression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createLatencyTrace.mockReturnValue({
      measure: vi.fn(async (_name: string, operation: () => unknown) => operation()),
      measureDb: vi.fn(async (_name: string, operation: () => unknown) => operation()),
      add: vi.fn(),
      snapshot: vi.fn(() => ({})),
    });
    mocks.cacheGet.mockResolvedValue(null);
    mocks.cacheSet.mockResolvedValue(undefined);
    mocks.cacheDelete.mockResolvedValue(undefined);
    mocks.whatsappAccountFindFirst.mockResolvedValue(account);
    mocks.conversationMessageFindFirst.mockResolvedValue(null);
    mocks.getOrCreateConversation.mockResolvedValue({ id: 77, aiEnabled: false });
    mocks.saveMessage.mockResolvedValue({ id: 88 });
    mocks.suppressionUpsert.mockResolvedValue({ id: 99 });
    mocks.conversationMessageUpdateMany.mockResolvedValue({ count: 1 });
    mocks.reconcileNotificationDeliveryStatus.mockResolvedValue(undefined);
    mocks.enqueueOrderAction.mockResolvedValue(undefined);
    mocks.classifyInboundMessageSignal.mockReturnValue({
      shouldTriggerAi: true,
    });
  });

  it("routes an order action before identity or AI work", async () => {
    await processMetaMessage({
      platform: "whatsapp",
      identifier: "phone-number-id",
      phoneNumberId: "phone-number-id",
      businessProfileId: 11,
      senderId: "+201001234567",
      customerPhone: "+201001234567",
      messageText: "button payload must not reach AI",
      type: "ORDER_ACTION",
      orderActionId: "opaque-action-token",
      buttonTitle: "Confirm",
      externalId: "wamid-action-1",
    });

    expect(mocks.enqueueOrderAction).toHaveBeenCalledWith({
      businessProfileId: 11,
      phoneNumberId: "phone-number-id",
      customerPhone: "+201001234567",
      actionToken: "opaque-action-token",
      inboundMessageId: "wamid-action-1",
      buttonTitle: "Confirm",
      correlationId: "meta-order-action-wamid-action-1",
    });
    expect(mocks.whatsappAccountFindFirst).not.toHaveBeenCalled();
    expect(mocks.computeBusinessChatReply).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.loggerInfo.mock.calls)).not.toContain("opaque-action-token");
  });

  it("persists a WhatsApp opt-out after the inbound message and skips AI", async () => {
    mocks.getOrCreateConversation.mockResolvedValue({ id: 77, aiEnabled: true });

    await processMetaMessage({
      platform: "whatsapp",
      identifier: "phone-number-id",
      phoneNumberId: "phone-number-id",
      businessProfileId: 11,
      senderId: "+201001234567",
      customerPhone: "+201001234567",
      messageText: "  STOP!!! ",
      type: "text",
      externalId: "wamid-opt-out-1",
    });

    expect(mocks.saveMessage).toHaveBeenCalledWith(
      77,
      "user",
      "  STOP!!! ",
      expect.objectContaining({ externalId: "wamid-opt-out-1", type: "text" }),
    );
    expect(mocks.suppressionUpsert).toHaveBeenCalledWith({
      where: {
        businessProfileId_normalizedPhone: {
          businessProfileId: 11,
          normalizedPhone: "+201001234567",
        },
      },
      update: {
        reason: "CUSTOMER_OPT_OUT",
        source: "WHATSAPP",
        clearedAt: null,
      },
      create: {
        businessProfileId: 11,
        normalizedPhone: "+201001234567",
        reason: "CUSTOMER_OPT_OUT",
        source: "WHATSAPP",
      },
    });
    expect(mocks.computeBusinessChatReply).not.toHaveBeenCalled();
    expect(mocks.startConversationAiRun).not.toHaveBeenCalled();
  });

  it("records suppression when the same opt-out webhook retries after an upsert failure", async () => {
    mocks.getOrCreateConversation.mockResolvedValue({ id: 77, aiEnabled: true });
    mocks.conversationMessageFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 88 });
    mocks.suppressionUpsert
      .mockRejectedValueOnce(new Error("suppression unavailable"))
      .mockResolvedValueOnce({ id: 99 });

    const job = {
      platform: "whatsapp" as const,
      identifier: "phone-number-id",
      phoneNumberId: "phone-number-id",
      businessProfileId: 11,
      senderId: "+201001234567",
      customerPhone: "+201001234567",
      messageText: "STOP",
      type: "text",
      externalId: "wamid-retry-1",
    };

    await expect(processMetaMessage(job)).rejects.toThrow("suppression unavailable");
    await expect(processMetaMessage(job)).resolves.toBeUndefined();

    expect(mocks.saveMessage).toHaveBeenCalledTimes(1);
    expect(mocks.suppressionUpsert).toHaveBeenCalledTimes(2);
    expect(mocks.computeBusinessChatReply).not.toHaveBeenCalled();
    expect(mocks.startConversationAiRun).not.toHaveBeenCalled();
  });

  it("reconciles WhatsApp delivery receipts without allowing status downgrades", async () => {
    await processMetaMessage({
      platform: "whatsapp",
      identifier: "",
      senderId: "",
      messageText: "",
      type: "status_update",
      externalId: "wamid-outbound-1",
      statusEvent: "READ",
    });

    expect(mocks.conversationMessageUpdateMany).toHaveBeenCalledWith({
      where: { externalId: "wamid-outbound-1" },
      data: { status: "READ" },
    });
    expect(mocks.reconcileNotificationDeliveryStatus).toHaveBeenCalledWith({
      providerMessageId: "wamid-outbound-1",
      status: "READ",
      error: undefined,
    });
    expect(mocks.computeBusinessChatReply).not.toHaveBeenCalled();
  });
});
