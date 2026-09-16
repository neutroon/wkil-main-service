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
  facebookPageFindMany: vi.fn(),
  facebookPageFindFirst: vi.fn(),
  getMessengerConversationForUser: vi.fn(),
  saveManualReplyAndTakeHumanControl: vi.fn(),
  sendMessengerReply: vi.fn(),
  replyToComment: vi.fn(),
  sendPrivateReply: vi.fn(),
  mirrorCommentReplyToMessenger: vi.fn(),
  decryptFacebookSecret: vi.fn(),
  getAccessibleProfileIds: vi.fn(),
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
    facebookPage: { findFirst: mocks.facebookPageFindFirst, findMany: mocks.facebookPageFindMany },
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

vi.mock("@modules/auth/core/tokenCrypto", () => ({ decryptFacebookSecret: mocks.decryptFacebookSecret }));
vi.mock("@modules/auth/user/user.service", () => ({
  getAccessibleProfileIds: mocks.getAccessibleProfileIds,
}));
vi.mock("@modules/meta/core/conversation.service", () => ({
  listMessengerConversations: vi.fn(),
  listConversationMessages: vi.fn(),
  getMessengerConversationForUser: mocks.getMessengerConversationForUser,
  saveMessage: vi.fn(),
  saveManualReplyAndTakeHumanControl: mocks.saveManualReplyAndTakeHumanControl,
}));
vi.mock("@modules/meta/messenger/messenger.service", () => ({
  sendMessengerMedia: vi.fn(),
  sendMessengerReply: mocks.sendMessengerReply,
}));
vi.mock("@modules/meta/facebook/facebook.service", () => ({
  replyToComment: mocks.replyToComment,
  sendPrivateReply: mocks.sendPrivateReply,
}));
vi.mock("@modules/meta/core/metaDelivery.service", () => ({
  mirrorCommentReplyToMessenger: mocks.mirrorCommentReplyToMessenger,
}));
vi.mock("@modules/ai-agent/customer/customerDecision.service", () => ({
  CustomerDeliveryAmbiguousError: class CustomerDeliveryAmbiguousError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "CustomerDeliveryAmbiguousError";
    }
  },
}));
vi.mock("@modules/meta/core/metaUpload.service", () => ({ uploadMessengerMedia: vi.fn() }));
vi.mock("@middlewares/errorHandler.middleware", () => ({
  AppError: class AppError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));
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

describe("Messenger manual replies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAccessibleProfileIds.mockResolvedValue([10]);
    mocks.facebookPageFindMany.mockResolvedValue([{ pageId: "owned-page" }]);
    mocks.decryptFacebookSecret.mockReturnValue("decrypted-page-token");
    mocks.facebookPageFindFirst.mockResolvedValue({
      pageId: "owned-page",
      pageAccessToken: "encrypted-page-token",
      businessProfileId: 10,
    });
    mocks.getMessengerConversationForUser.mockResolvedValue({
      id: 45,
      businessProfileId: 10,
      pageId: "owned-page",
      senderId: "psid-1",
      channel: "messenger",
      externalId: null,
      postId: null,
    });
    mocks.sendMessengerReply.mockResolvedValue({ message_id: "mid.out-1", recipient_id: "psid-1" });
    mocks.saveManualReplyAndTakeHumanControl.mockImplementation(async (params: any) => {
      const provider = await params.deliver({
        id: 501,
        conversationId: params.conversationId,
        role: "agent",
        content: params.content,
        status: "SENDING",
        externalId: null,
      });
      return {
        id: 501,
        conversationId: params.conversationId,
        role: "agent",
        content: params.content,
        status: "SENT",
        externalId: provider.externalId,
      };
    });
  });

  function manualReplyRequest(overrides: Record<string, unknown> = {}) {
    return {
      user: { id: 7 },
      params: { id: "45" },
      body: { message: "  Hello  " },
      ...overrides,
    } as any;
  }

  it("returns 404 before any provider call for another tenant's conversation", async () => {
    mocks.getMessengerConversationForUser.mockResolvedValue(null);

    await expect(messengerController.sendManualReply(manualReplyRequest(), response()))
      .rejects.toMatchObject({ statusCode: 404 });

    expect(mocks.getMessengerConversationForUser).toHaveBeenCalledWith("45", ["owned-page"]);
    expect(mocks.getAccessibleProfileIds).toHaveBeenCalledWith(7);
    expect(mocks.facebookPageFindMany).toHaveBeenCalledWith({
      where: { businessProfileId: { in: [10] }, isActive: true },
      select: { pageId: true },
    });
    expect(mocks.facebookPageFindFirst).not.toHaveBeenCalled();
    expect(mocks.sendMessengerReply).not.toHaveBeenCalled();
    expect(mocks.replyToComment).not.toHaveBeenCalled();
    expect(mocks.sendPrivateReply).not.toHaveBeenCalled();
  });

  it("scopes credentials to the authorized conversation page and business", async () => {
    const res = response();

    await messengerController.sendManualReply(manualReplyRequest(), res);

    expect(mocks.facebookPageFindFirst).toHaveBeenCalledWith({
      where: { pageId: "owned-page", businessProfileId: 10, isActive: true },
      select: { pageId: true, pageAccessToken: true, businessProfileId: true },
    });
    expect(mocks.sendMessengerReply).toHaveBeenCalledWith("psid-1", "Hello", "decrypted-page-token");
    expect(mocks.saveManualReplyAndTakeHumanControl).toHaveBeenCalledWith({
      businessProfileId: 10,
      conversationId: 45,
      channel: "messenger",
      content: "Hello",
      isPrivate: false,
      origin: "messenger_manual_reply",
      deliver: expect.any(Function),
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("preserves public Facebook comment transport and persists its provider ID", async () => {
    mocks.getMessengerConversationForUser.mockResolvedValue({
      id: 46,
      businessProfileId: 10,
      pageId: "owned-page",
      senderId: "commenter-1",
      channel: "facebook_comment",
      externalId: "comment.in-1",
      postId: "post-1",
    });
    mocks.replyToComment.mockResolvedValue({ id: "comment.out-1" });
    const res = response();

    await messengerController.sendManualReply(manualReplyRequest({
      params: { id: "46" },
      body: { message: " Public answer ", isPrivate: false },
    }), res);

    expect(mocks.replyToComment).toHaveBeenCalledWith({
      commentId: "comment.in-1",
      message: "Public answer",
      accessToken: "decrypted-page-token",
      pageId: "owned-page",
    });
    expect(mocks.sendMessengerReply).not.toHaveBeenCalled();
    expect(mocks.saveManualReplyAndTakeHumanControl).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 46,
      channel: "facebook_comment",
      isPrivate: false,
      origin: "facebook_comment_reply",
      deliver: expect.any(Function),
    }));
  });

  it("uses the private comment transport and mirrors only after durable persistence", async () => {
    mocks.getMessengerConversationForUser.mockResolvedValue({
      id: 46,
      businessProfileId: 10,
      pageId: "owned-page",
      senderId: "commenter-1",
      channel: "facebook_comment",
      externalId: "comment.in-1",
      postId: "post-1",
    });
    mocks.sendPrivateReply.mockResolvedValue({ id: "mid.private-1" });

    await messengerController.sendManualReply(manualReplyRequest({
      params: { id: "46" },
      body: { message: " Private answer ", isPrivate: true },
    }), response());

    expect(mocks.sendPrivateReply).toHaveBeenCalledWith({
      commentId: "comment.in-1",
      message: "Private answer",
      accessToken: "decrypted-page-token",
      pageId: "owned-page",
      businessProfileId: 10,
    });
    expect(mocks.saveManualReplyAndTakeHumanControl).toHaveBeenCalledWith(expect.objectContaining({
      isPrivate: true,
      origin: "facebook_comment_reply",
      deliver: expect.any(Function),
    }));
    expect(mocks.mirrorCommentReplyToMessenger).toHaveBeenCalledWith(expect.objectContaining({
      pageId: "owned-page",
      senderId: "commenter-1",
      businessProfileId: 10,
      messageId: "mid.private-1",
      role: "agent",
    }));
    expect(mocks.saveManualReplyAndTakeHumanControl.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.mirrorCommentReplyToMessenger.mock.invocationCallOrder[0]);
  });

  it("persists the delivery claim before a provider rejection", async () => {
    mocks.sendMessengerReply.mockRejectedValue(new Error("Meta rejected send"));

    await expect(messengerController.sendManualReply(manualReplyRequest(), response()))
      .rejects.toThrow("Meta rejected send");

    expect(mocks.saveManualReplyAndTakeHumanControl).toHaveBeenCalledOnce();
  });

  it("treats a provider success without a message ID as ambiguous", async () => {
    mocks.sendMessengerReply.mockResolvedValue({ recipient_id: "psid-1" });

    await expect(messengerController.sendManualReply(manualReplyRequest(), response()))
      .rejects.toMatchObject({ name: "CustomerDeliveryAmbiguousError" });

    expect(mocks.saveManualReplyAndTakeHumanControl).toHaveBeenCalledOnce();
  });

  it("propagates an ambiguous manual-delivery service outcome", async () => {
    const error = new Error("provider accepted, local confirmation ambiguous");
    error.name = "CustomerDeliveryAmbiguousError";
    mocks.saveManualReplyAndTakeHumanControl.mockRejectedValue(error);

    await expect(messengerController.sendManualReply(manualReplyRequest(), response()))
      .rejects.toMatchObject({ name: "CustomerDeliveryAmbiguousError" });

    expect(mocks.sendMessengerReply).not.toHaveBeenCalled();
  });
});
