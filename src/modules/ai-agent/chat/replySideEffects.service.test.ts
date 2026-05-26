import { describe, expect, it } from "vitest";
import { shouldScheduleFollowUpsForSavedReply } from "./replySideEffects.service";

const baseParams = {
  businessProfileId: 1,
  conversationId: 2,
  message: { id: 3, handoffCategory: null },
};

describe("shouldScheduleFollowUpsForSavedReply", () => {
  it("does not schedule follow-ups while the bot is waiting for customer details", () => {
    expect(
      shouldScheduleFollowUpsForSavedReply({
        ...baseParams,
        reply: {
          action: "REPLY_AUTO",
          replyType: "CLARIFICATION",
          reasoning: "need selected program",
          handoffCategory: null,
        } as any,
      }),
    ).toBe(false);

    expect(
      shouldScheduleFollowUpsForSavedReply({
        ...baseParams,
        reply: {
          action: "REPLY_AUTO",
          replyType: "NORMAL_REPLY",
          reasoning: "need selected program",
          handoffCategory: null,
          missingInfo: "selected program",
        } as any,
      }),
    ).toBe(false);
  });

  it("still schedules follow-ups for normal completed replies", () => {
    expect(
      shouldScheduleFollowUpsForSavedReply({
        ...baseParams,
        reply: {
          action: "REPLY_AUTO",
          replyType: "NORMAL_REPLY",
          reasoning: "answered the question",
          handoffCategory: null,
        } as any,
      }),
    ).toBe(true);
  });
});
