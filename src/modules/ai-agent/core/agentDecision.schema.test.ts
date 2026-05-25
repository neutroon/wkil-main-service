import { describe, expect, it } from "vitest";
import { getAiRoutingDecisionSchemaForChannel } from "./agentDecision.schema";

const baseDecision = {
  action: "REPLY_AUTO",
  replyType: "NORMAL_REPLY",
  reasoning: "ok",
  requiresGrounding: false,
  grounded: false,
  usedChunkTypes: [],
  missingInfo: null,
  attachment: null,
};

describe("getAiRoutingDecisionSchemaForChannel", () => {
  it("does not expose comment-only fields to direct chat channels", () => {
    const parsed = getAiRoutingDecisionSchemaForChannel("messenger").parse({
      ...baseDecision,
      content: "direct reply",
      publicContent: "public reply",
      privateContent: "private reply",
    });

    expect(parsed).toMatchObject({ content: "direct reply" });
    expect("publicContent" in parsed).toBe(false);
    expect("privateContent" in parsed).toBe(false);
  });

  it("keeps public/private fields for facebook comments", () => {
    const parsed = getAiRoutingDecisionSchemaForChannel("facebook_comment").parse({
      ...baseDecision,
      publicContent: "public reply",
      privateContent: "private reply",
      intent: "SALES_DM",
    });

    expect(parsed).toMatchObject({
      publicContent: "public reply",
      privateContent: "private reply",
      intent: "SALES_DM",
    });
    expect("content" in parsed).toBe(false);
  });
});
