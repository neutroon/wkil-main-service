import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  conversationMessageFindFirst: vi.fn(),
  getRoutableFacebookPageRoute: vi.fn(),
  enqueueInboundMetaEvent: vi.fn(),
  enqueueMetaJob: vi.fn(),
  verifyMetaWebhookSignature: vi.fn(),
  loggerDebug: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@config/env", () => ({
  env: {
    NODE_ENV: "test",
    MESSENGER_VERIFY_TOKEN: "verify-token",
    FB_APP_SECRET: "app-secret",
  },
}));

vi.mock("@config/prisma", () => ({
  default: {
    conversationMessage: { findFirst: mocks.conversationMessageFindFirst },
    businessProfile: { findMany: vi.fn() },
    facebookPage: { findFirst: vi.fn(), findMany: vi.fn() },
    conversation: { findUnique: vi.fn() },
  },
}));

vi.mock("@utils/logger", () => ({
  logger: {
    debug: mocks.loggerDebug,
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

vi.mock("@modules/auth/core/tokenCrypto", () => ({ decryptFacebookSecret: vi.fn() }));
vi.mock("@modules/meta/core/conversation.service", () => ({
  listMessengerConversations: vi.fn(),
  listConversationMessages: vi.fn(),
  getMessengerConversationForUser: vi.fn(),
  saveMessage: vi.fn(),
}));
vi.mock("@modules/meta/messenger/messenger.service", () => ({ sendMessengerMedia: vi.fn() }));
vi.mock("@modules/meta/core/metaUpload.service", () => ({ uploadMessengerMedia: vi.fn() }));
vi.mock("@middlewares/errorHandler.middleware", () => ({ AppError: class AppError extends Error {} }));
vi.mock("@modules/meta/core/metaWebhook", () => ({ verifyMetaWebhookSignature: mocks.verifyMetaWebhookSignature }));
vi.mock("@modules/meta/core/meta.queue", () => ({
  enqueueInboundMetaEvent: mocks.enqueueInboundMetaEvent,
  enqueueMetaJob: mocks.enqueueMetaJob,
}));
vi.mock("@modules/meta/core/webhookCache.service", () => ({
  getRoutableFacebookPageRoute: mocks.getRoutableFacebookPageRoute,
}));

import { messengerController } from "./messenger.controller";

function response() {
  return {
    headersSent: false,
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as any;
}

function webhookRequest(body: unknown) {
  return {
    body: Buffer.from(JSON.stringify(body)),
    headers: { "x-hub-signature-256": "sha256=valid" },
  } as any;
}

function pageEntry(overrides: Record<string, unknown> = {}) {
  return {
    object: "page",
    entry: [{
      id: "page-1",
      time: 1_720_000_001,
      ...overrides,
    }],
  };
}

describe("Messenger webhook controller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyMetaWebhookSignature.mockReturnValue(true);
    mocks.getRoutableFacebookPageRoute.mockResolvedValue({ businessProfileId: 11 });
    mocks.conversationMessageFindFirst.mockResolvedValue(null);
    mocks.enqueueInboundMetaEvent.mockResolvedValue(undefined);
    mocks.enqueueMetaJob.mockResolvedValue(undefined);
  });

  it("verifies the signature before acknowledging or queueing", async () => {
    mocks.verifyMetaWebhookSignature.mockReturnValue(false);
    const res = response();

    await messengerController.handleWebhook(webhookRequest(pageEntry()), res);

    expect(mocks.verifyMetaWebhookSignature).toHaveBeenCalledOnce();
    expect(mocks.getRoutableFacebookPageRoute).not.toHaveBeenCalled();
    expect(mocks.enqueueInboundMetaEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.send).toHaveBeenCalledWith("INVALID_SIGNATURE");
  });

  it("waits for durable Messenger enqueueing before acknowledging", async () => {
    let releaseQueue!: () => void;
    mocks.enqueueInboundMetaEvent.mockImplementation(() => new Promise<void>((resolve) => { releaseQueue = resolve; }));
    const res = response();
    const work = messengerController.handleWebhook(webhookRequest(pageEntry({ messaging: [{
      sender: { id: "psid-1" }, recipient: { id: "page-1" }, timestamp: 1_720_000_000_000,
      message: { mid: "mid.in-1", text: "hello" },
    }] })), res);

    await Promise.resolve();
    expect(mocks.enqueueInboundMetaEvent).toHaveBeenCalledOnce();
    expect(res.send).not.toHaveBeenCalled();

    releaseQueue();
    await work;
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith("EVENT_RECEIVED");
  });

  it("returns a retryable error instead of an acknowledgement when enqueueing fails", async () => {
    mocks.enqueueInboundMetaEvent.mockRejectedValueOnce(new Error("queue unavailable"));
    const res = response();

    await messengerController.handleWebhook(webhookRequest(pageEntry({ messaging: [{
      sender: { id: "psid-1" }, recipient: { id: "page-1" },
      message: { mid: "mid.in-1", text: "hello" },
    }] })), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.send).toHaveBeenCalledWith("WEBHOOK_PROCESSING_FAILED");
    expect(res.status).not.toHaveBeenCalledWith(200);
  });

  it("keeps comments distinct from Messenger and preserves Meta comment identity and occurrence time", async () => {
    const res = response();
    await messengerController.handleWebhook(webhookRequest(pageEntry({ changes: [{
      field: "feed",
      value: {
        item: "comment", verb: "add", id: "comment.in-1", post_id: "post-1", created_time: 1_720_000_000,
        from: { id: "commenter-1", name: "Ada" }, message: "Need details",
      },
    }] })), res);

    expect(mocks.enqueueInboundMetaEvent).toHaveBeenCalledWith({
      platform: "facebook_comment",
      eventId: "comment.in-1",
      payload: expect.objectContaining({
        channel: "facebook_comment",
        commentId: "comment.in-1",
        postId: "post-1",
        occurredAt: "2024-07-03T09:46:40.000Z",
      }),
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("does not enqueue a comment without a real post ID", async () => {
    const res = response();
    await messengerController.handleWebhook(webhookRequest(pageEntry({ changes: [{
      field: "feed",
      value: {
        item: "comment", verb: "add", id: "comment.in-1", created_time: "2024-07-03T09:46:40Z",
        from: { id: "commenter-1" }, message: "Need details",
      },
    }] })), res);

    expect(mocks.enqueueInboundMetaEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith("EVENT_RECEIVED");
  });

  it("suppresses a public comment echo after its public reply has been audited", async () => {
    mocks.conversationMessageFindFirst.mockResolvedValue({ id: 42 });
    const res = response();
    await messengerController.handleWebhook(webhookRequest(pageEntry({ changes: [{
      field: "feed",
      value: {
        item: "comment", verb: "add", id: "comment.public-1", post_id: "post-1", created_time: 1_720_000_000,
        from: { id: "page-1" }, message: "Thanks! Check your inbox.",
      },
    }] })), res);

    expect(mocks.conversationMessageFindFirst).toHaveBeenCalledWith({
      where: { externalId: "comment.public-1" },
      select: { id: true },
    });
    expect(mocks.enqueueInboundMetaEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("preserves the GET verification challenge endpoint", async () => {
    const res = response();
    await messengerController.verifyWebhook({ query: {
      "hub.mode": "subscribe", "hub.verify_token": "verify-token", "hub.challenge": "challenge",
    } } as any, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith("challenge");
  });
});
