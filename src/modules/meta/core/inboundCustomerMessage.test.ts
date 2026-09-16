import { describe, expect, it } from "vitest";
import {
  inboundCustomerMessageSchema,
  type InboundCustomerMessage,
} from "./inboundCustomerMessage";

const base = {
  businessProfileId: 12,
  identifier: "phone-number-id",
  senderId: "201234567890",
  externalId: "wamid.test-1",
  text: "Hello",
  receivedAt: "2026-09-16T10:00:00.000Z",
  attachments: [],
};

describe("InboundCustomerMessage", () => {
  it("accepts a strict WhatsApp customer envelope", () => {
    const value = inboundCustomerMessageSchema.parse({
      ...base,
      channel: "whatsapp",
      phoneNumberId: "phone-number-id",
      customerPhone: "+201234567890",
    });

    expect(value.channel).toBe("whatsapp");
    expect(value.externalId).toBe("wamid.test-1");
  });

  it("keeps Facebook comments separate from Messenger with comment context", () => {
    const value: InboundCustomerMessage = inboundCustomerMessageSchema.parse({
      ...base,
      channel: "facebook_comment",
      identifier: "page-1",
      externalId: "comment-1",
      pageId: "page-1",
      commentId: "comment-1",
      postId: "post-1",
      occurredAt: "2026-09-16T10:00:00.000Z",
      parentId: "parent-1",
      source: "page_feed",
    });

    expect(value.channel).toBe("facebook_comment");
    if (value.channel !== "facebook_comment") throw new Error("Expected comment envelope");
    expect(value.commentId).toBe("comment-1");
  });

  it("rejects overlong text, too many attachments, unknown fields, and incomplete comments", () => {
    expect(() => inboundCustomerMessageSchema.parse({
      ...base,
      channel: "messenger",
      pageId: "page-1",
      text: "x".repeat(12_001),
    })).toThrow();
    expect(() => inboundCustomerMessageSchema.parse({
      ...base,
      channel: "messenger",
      pageId: "page-1",
      attachments: Array.from({ length: 11 }, (_, index) => ({ type: "image", id: String(index) })),
    })).toThrow();
    expect(() => inboundCustomerMessageSchema.parse({
      ...base,
      channel: "messenger",
      pageId: "page-1",
      unexpected: true,
    })).toThrow();
    expect(() => inboundCustomerMessageSchema.parse({
      ...base,
      channel: "facebook_comment",
      pageId: "page-1",
      commentId: "comment-1",
    })).toThrow();
  });
});
