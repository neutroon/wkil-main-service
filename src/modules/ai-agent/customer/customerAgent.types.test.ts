import { describe, expect, it } from "vitest";
import { customerAgentDecisionSchema } from "./customerAgent.types";

describe("customerAgentDecisionSchema", () => {
  it("accepts a reply and rejects content on NO_REPLY", () => {
    expect(
      customerAgentDecisionSchema.parse({
        action: "REPLY",
        content: "We are open at 9.",
        reason_code: "KNOWLEDGE_MATCH",
        handoff_category: null,
      }).action,
    ).toBe("REPLY");

    expect(() =>
      customerAgentDecisionSchema.parse({
        action: "NO_REPLY",
        content: "must not send",
        reason_code: "POLICY_SUPPRESSED",
      }),
    ).toThrow();
  });

  it("preserves a validated attachment request in a reply decision", () => {
    expect(customerAgentDecisionSchema.parse({
      action: "REPLY",
      content: "Here is the brochure.",
      reason_code: "KNOWLEDGE_MATCH",
      handoff_category: null,
      attachment: { asset_name: "brochure", caption: "Product details" },
    })).toMatchObject({
      attachment: { asset_name: "brochure", caption: "Product details" },
    });
  });
});
