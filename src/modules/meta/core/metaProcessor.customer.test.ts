import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cacheGet: vi.fn(), cacheSet: vi.fn(), cacheDelete: vi.fn(),
  pageFindFirst: vi.fn(), accountFindFirst: vi.fn(),
  messageFindFirst: vi.fn(), messageUpdateMany: vi.fn(),
  getOrCreateConversation: vi.fn(), saveMessage: vi.fn(),
  executeCustomerTurn: vi.fn(), applyCustomerDecision: vi.fn(),
  sendWhatsAppReply: vi.fn(), sendMessengerReply: vi.fn(),
  replyToComment: vi.fn(), sendPrivateReply: vi.fn(), mirrorCommentReplyToMessenger: vi.fn(),
}));

vi.mock("bullmq", () => ({ UnrecoverableError: class UnrecoverableError extends Error {} }));
vi.mock("@config/prisma", () => ({
  default: {
    facebookPage: { findFirst: mocks.pageFindFirst },
    whatsAppAccount: { findFirst: mocks.accountFindFirst },
    conversationMessage: { findFirst: mocks.messageFindFirst, updateMany: mocks.messageUpdateMany },
  },
}));
vi.mock("@utils/cache", () => ({ cache: { get: mocks.cacheGet, set: mocks.cacheSet, delete: mocks.cacheDelete } }));
vi.mock("@utils/logger", () => ({ logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@modules/auth/core/tokenCrypto", () => ({ decryptFacebookSecret: vi.fn((value: string) => `clear:${value}`) }));
vi.mock("@modules/meta/core/conversation.service", () => ({ getOrCreateConversation: mocks.getOrCreateConversation, saveMessage: mocks.saveMessage }));
vi.mock("@modules/meta/core/inboundMediaUnderstanding.service", () => ({ understandInboundMedia: vi.fn() }));
vi.mock("@modules/order-confirmation/orderConfirmation.queue", () => ({ enqueueOrderAction: vi.fn() }));
vi.mock("@modules/order-confirmation/orderConfirmation.repository", () => ({ reconcileNotificationDeliveryStatus: vi.fn() }));
vi.mock("@modules/ai-agent/customer/customerAgent.service", () => ({ executeCustomerTurn: mocks.executeCustomerTurn }));
vi.mock("@modules/ai-agent/customer/customerDecision.service", () => ({
  applyCustomerDecision: mocks.applyCustomerDecision,
  CustomerDeliveryAmbiguousError: class CustomerDeliveryAmbiguousError extends Error {},
}));
vi.mock("@modules/meta/whatsapp/whatsapp.service", () => ({ sendWhatsAppReply: mocks.sendWhatsAppReply }));
vi.mock("@modules/meta/messenger/messenger.service", () => ({ sendMessengerReply: mocks.sendMessengerReply }));
vi.mock("@modules/meta/facebook/facebook.service", () => ({
  getFacebookUserProfile: vi.fn(), replyToComment: mocks.replyToComment, sendPrivateReply: mocks.sendPrivateReply,
}));
vi.mock("@modules/meta/core/metaDelivery.service", () => ({ mirrorCommentReplyToMessenger: mocks.mirrorCommentReplyToMessenger }));

import { processMetaMessage } from "./metaProcessor.service";

const decision = { action: "REPLY", content: "AI answer", reason_code: "KNOWLEDGE_MATCH", handoff_category: null } as const;

function messengerPage(overrides: Record<string, unknown> = {}) {
  return {
    businessProfileId: 11, pageAccessToken: "encrypted", isTokenValid: true,
    commentAutoDmEnabled: false, commentPublicGreeting: "Thanks {{name}}! Check your inbox.",
    facebookAccount: { isActive: true }, businessProfile: { userId: 3, agentActionSources: [] },
    ...overrides,
  };
}

describe("customer Meta channel processors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cacheGet.mockResolvedValue(null); mocks.cacheSet.mockResolvedValue(undefined); mocks.cacheDelete.mockResolvedValue(undefined);
    mocks.pageFindFirst.mockResolvedValue(messengerPage());
    mocks.accountFindFirst.mockResolvedValue({ businessProfileId: 11, accessToken: "encrypted", isTokenValid: true, aiRepliesEnabled: true, businessProfile: { userId: 3, agentActionSources: [] } });
    mocks.messageFindFirst.mockResolvedValue(null);
    mocks.getOrCreateConversation.mockResolvedValue({ id: 45, aiEnabled: true, senderId: "customer-1" });
    mocks.saveMessage.mockResolvedValue({ id: 71 });
    mocks.executeCustomerTurn.mockResolvedValue({ agentTurnId: 81, decision });
    mocks.replyToComment.mockResolvedValue({ id: "comment.out-default" });
    mocks.sendPrivateReply.mockResolvedValue({ id: "mid.private-default" });
    mocks.mirrorCommentReplyToMessenger.mockResolvedValue({ id: 72 });
    mocks.applyCustomerDecision.mockImplementation(async (params: any) => {
      await params.deliver({ id: 99, conversationId: 45, agentTurnId: 81, content: "AI answer", status: "SENDING", externalId: null });
      return { action: "REPLY" };
    });
  });

  it("uses the WhatsApp provider ID and the saved input message as the customer-turn key", async () => {
    mocks.sendWhatsAppReply.mockResolvedValue({ messages: [{ id: "wamid.out-1" }] });
    await processMetaMessage({
      channel: "whatsapp", businessProfileId: 11, identifier: "phone-1", phoneNumberId: "phone-1",
      senderId: "+2010", customerPhone: "+2010", externalId: "wamid.in-1", text: "hello",
      receivedAt: "2026-09-16T10:00:00.000Z", attachments: [],
    });
    expect(mocks.executeCustomerTurn).toHaveBeenCalledWith(expect.objectContaining({ inputMessageId: 71, dedupeKey: "message:71", channel: "whatsapp" }));
    expect(mocks.sendWhatsAppReply).toHaveBeenCalledWith("+2010", "AI answer", "phone-1", "clear:encrypted");
  });

  it("uses Messenger message_id delivery without turning the event into a comment", async () => {
    mocks.sendMessengerReply.mockResolvedValue({ message_id: "mid.out-1" });
    await processMetaMessage({
      channel: "messenger", businessProfileId: 11, identifier: "page-1", pageId: "page-1",
      senderId: "psid-1", externalId: "mid.in-1", text: "hello",
      receivedAt: "2026-09-16T10:00:00.000Z", attachments: [],
    });
    expect(mocks.executeCustomerTurn).toHaveBeenCalledWith(expect.objectContaining({ channel: "messenger" }));
    expect(mocks.sendMessengerReply).toHaveBeenCalledWith("psid-1", "AI answer", "clear:encrypted");
    expect(mocks.replyToComment).not.toHaveBeenCalled();
  });

  it("keeps a Facebook comment thread anchored to its comment and applies configured public-plus-private delivery", async () => {
    mocks.pageFindFirst.mockResolvedValue(messengerPage({ commentAutoDmEnabled: true }));
    mocks.replyToComment.mockResolvedValue({ id: "comment.out-1" });
    mocks.sendPrivateReply.mockResolvedValue({ id: "mid.private-1" });
    await processMetaMessage({
      channel: "facebook_comment", businessProfileId: 11, identifier: "page-1", pageId: "page-1",
      senderId: "commenter-1", externalId: "comment.in-1", commentId: "comment.in-1", postId: "post-1", parentId: "parent-1",
      source: "page_feed", text: "Need details", customerName: "Ada", occurredAt: "2026-09-16T10:00:00.000Z", receivedAt: "2026-09-16T10:00:00.000Z", attachments: [],
    });
    expect(mocks.getOrCreateConversation).toHaveBeenCalledWith("page-1", "commenter-1", 11, expect.objectContaining({
      channel: "facebook_comment", externalId: "comment.in-1", postId: "post-1",
    }));
    expect(mocks.executeCustomerTurn).toHaveBeenCalledWith(expect.objectContaining({ channel: "facebook_comment" }));
    expect(mocks.replyToComment).toHaveBeenCalledWith(expect.objectContaining({ commentId: "comment.in-1", message: "Thanks Ada! Check your inbox." }));
    expect(mocks.saveMessage).toHaveBeenNthCalledWith(2, 45, "model", "Thanks Ada! Check your inbox.", {
      externalId: "comment.out-1",
      status: "SENT",
      isPrivate: false,
      origin: "facebook_comment_public_reply",
    });
    expect(mocks.sendPrivateReply).toHaveBeenCalledWith(expect.objectContaining({ commentId: "comment.in-1", message: "AI answer" }));
    expect(mocks.mirrorCommentReplyToMessenger).toHaveBeenCalledWith(expect.objectContaining({ commentId: "comment.in-1", messageId: "mid.private-1" }));
  });

  it("does not make a public comment retryable when the subsequent private outcome fails", async () => {
    mocks.pageFindFirst.mockResolvedValue(messengerPage({ commentAutoDmEnabled: true }));
    mocks.replyToComment.mockResolvedValue({ id: "comment.out-1" });
    mocks.sendPrivateReply.mockRejectedValue(new Error("private reply rejected"));
    await expect(processMetaMessage({
      channel: "facebook_comment", businessProfileId: 11, identifier: "page-1", pageId: "page-1",
      senderId: "commenter-1", externalId: "comment.in-2", commentId: "comment.in-2", postId: "post-1",
      source: "page_feed", text: "Need details", occurredAt: "2026-09-16T10:00:00.000Z", receivedAt: "2026-09-16T10:00:00.000Z", attachments: [],
    })).rejects.toThrow("Facebook public comment was accepted but private reply outcome is ambiguous");
    expect(mocks.replyToComment).toHaveBeenCalledTimes(1);
  });

  it("keeps a successful public comment non-retryable when its echo audit cannot be persisted", async () => {
    mocks.pageFindFirst.mockResolvedValue(messengerPage({ commentAutoDmEnabled: true }));
    mocks.replyToComment.mockResolvedValue({ id: "comment.out-2" });
    mocks.saveMessage.mockResolvedValueOnce({ id: 71 }).mockRejectedValueOnce(new Error("audit unavailable"));

    await expect(processMetaMessage({
      channel: "facebook_comment", businessProfileId: 11, identifier: "page-1", pageId: "page-1",
      senderId: "commenter-1", externalId: "comment.in-3", commentId: "comment.in-3", postId: "post-1",
      source: "page_feed", text: "Need details", occurredAt: "2026-09-16T10:00:00.000Z", receivedAt: "2026-09-16T10:00:00.000Z", attachments: [],
    })).rejects.toThrow("Facebook public comment was accepted but public reply audit outcome is ambiguous");

    expect(mocks.replyToComment).toHaveBeenCalledTimes(1);
    expect(mocks.sendPrivateReply).not.toHaveBeenCalled();
  });
});
