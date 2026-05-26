import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  DEFAULT_AI_TRUTHFULNESS_POLICY,
  evaluateGuardrailsForReply,
  repairAndParseAiResponse,
  sanitizeAiText,
} from "./aiEngine.utils";

beforeAll(() => {
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "test-key";
});

describe("AI truthfulness guardrails", () => {
  it("blocks unverified actions with deterministic fallback", () => {
    const result = evaluateGuardrailsForReply(
      {
        verifiedActions: [],
        unverifiedActions: ["external_query_1"],
        failedActions: [],
        unknownActions: [],
      },
      DEFAULT_AI_TRUTHFULNESS_POLICY,
    );

    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.ruleId).toBe("TRUTH_UNVERIFIED_ACTION");
    }
  });

  it("blocks failed actions with failed fallback", () => {
    const result = evaluateGuardrailsForReply(
      {
        verifiedActions: [],
        unverifiedActions: [],
        failedActions: ["integration_action_2"],
        unknownActions: [],
      },
      DEFAULT_AI_TRUTHFULNESS_POLICY,
    );

    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.ruleId).toBe("TRUTH_FAILED_ACTION");
    }
  });

  it("allows verified evidence after deterministic evidence checks pass", () => {
    const result = evaluateGuardrailsForReply(
      {
        verifiedActions: ["integration_action_2"],
        unverifiedActions: [],
        failedActions: [],
        unknownActions: [],
      },
      DEFAULT_AI_TRUTHFULNESS_POLICY,
    );

    expect(result.blocked).toBe(false);
  });
});

describe("AI response parsing", () => {
  it("preserves intentional line breaks in customer-facing content", () => {
    expect(
      sanitizeAiText("عنوان:\r\n  - بند أول  \n\n\n - بند   ثاني"),
    ).toBe("عنوان:\n- بند أول\n\n- بند ثاني");
  });

  it("repairs accidental leading junk before a valid JSON object", () => {
    const decision = repairAndParseAiResponse(
      `H${JSON.stringify({
        action: "REPLY_AUTO",
        replyType: "NORMAL_REPLY",
        reasoning: "ok",
        content: "أهلاً بحضرتك.",
        requiresGrounding: true,
        grounded: true,
        usedChunkTypes: ["identity", "custom_section"],
        attachment: {
          assetName: "صور الشهادات",
          caption: "نماذج الشهادات",
        },
      })}`,
    );

    expect(decision.content).toBe("أهلاً بحضرتك.");
    expect(decision.usedChunkTypes).toEqual(["identity", "custom_section"]);
    expect(decision.attachment).toEqual({
      assetName: "صور الشهادات",
      caption: "نماذج الشهادات",
    });
  });

  it("ignores trailing text after a complete JSON object", () => {
    const decision = repairAndParseAiResponse(
      `${JSON.stringify({
        action: "REPLY_AUTO",
        replyType: "NORMAL_REPLY",
        reasoning: "ok",
        content: "reply",
        requiresGrounding: false,
        grounded: false,
        usedChunkTypes: [],
      })}\nextra text`,
    );

    expect(decision.content).toBe("reply");
    expect(decision.requiresGrounding).toBe(false);
  });

  it("rejects malformed partial JSON instead of inventing a fallback decision", () => {
    expect(() =>
      repairAndParseAiResponse(
        '{"action":"REPLY_AUTO","replyType":"NORMAL_REPLY","reasoning":"ok"',
      ),
    ).toThrow(/AI_RESPONSE_JSON_OBJECT_INCOMPLETE/);
  });

  it("rejects incomplete schema instead of filling defaults", () => {
    expect(() =>
      repairAndParseAiResponse(
        JSON.stringify({
          action: "REPLY_AUTO",
          content: "reply",
          requiresGrounding: false,
          grounded: false,
          usedChunkTypes: [],
        }),
      ),
    ).toThrow(/AI_RESPONSE_SCHEMA_INVALID:replyType/);
  });
});

