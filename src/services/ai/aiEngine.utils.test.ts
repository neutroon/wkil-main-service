import { describe, expect, it, beforeAll } from "vitest";

beforeAll(() => {
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-key";
});

describe("AI truthfulness guardrails", () => {
  it("blocks unverified actions with deterministic fallback", async () => {
    const { evaluateGuardrailsForReply, DEFAULT_AI_TRUTHFULNESS_POLICY } =
      await import("./aiEngine.utils");

    const result = evaluateGuardrailsForReply(
      {
        verifiedActions: [],
        unverifiedActions: ["external_query_1"],
        failedActions: [],
        unknownActions: [],
      },
      "Your order is confirmed.",
      DEFAULT_AI_TRUTHFULNESS_POLICY,
    );

    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.ruleId).toBe("TRUTH_UNVERIFIED_ACTION");
    }
  });

  it("blocks failed actions with failed fallback", async () => {
    const { evaluateGuardrailsForReply, DEFAULT_AI_TRUTHFULNESS_POLICY } =
      await import("./aiEngine.utils");

    const result = evaluateGuardrailsForReply(
      {
        verifiedActions: [],
        unverifiedActions: [],
        failedActions: ["capture_lead"],
        unknownActions: [],
      },
      "Done, everything is complete.",
      DEFAULT_AI_TRUTHFULNESS_POLICY,
    );

    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.ruleId).toBe("TRUTH_FAILED_ACTION");
    }
  });

  it("allows verified evidence when there is no unsupported promise", async () => {
    const { evaluateGuardrailsForReply, DEFAULT_AI_TRUTHFULNESS_POLICY } =
      await import("./aiEngine.utils");

    const result = evaluateGuardrailsForReply(
      {
        verifiedActions: ["capture_lead"],
        unverifiedActions: [],
        failedActions: [],
        unknownActions: [],
      },
      "Your request has been saved successfully.",
      DEFAULT_AI_TRUTHFULNESS_POLICY,
    );

    expect(result.blocked).toBe(false);
  });

  it("blocks unsupported promises even with verified action", async () => {
    const { evaluateGuardrailsForReply, DEFAULT_AI_TRUTHFULNESS_POLICY } =
      await import("./aiEngine.utils");

    const result = evaluateGuardrailsForReply(
      {
        verifiedActions: ["capture_lead"],
        unverifiedActions: [],
        failedActions: [],
        unknownActions: [],
      },
      "We will call you tomorrow to complete this.",
      DEFAULT_AI_TRUTHFULNESS_POLICY,
    );

    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.ruleId).toBe("PROMISE_UNSUPPORTED");
    }
  });
});
