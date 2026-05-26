import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildAiRecoveryDecisionMock } = vi.hoisted(() => ({
  buildAiRecoveryDecisionMock: vi.fn(),
}));

vi.mock("@utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./recoveryDecision", () => ({
  buildAiRecoveryDecision: buildAiRecoveryDecisionMock,
}));

import { runGuardrailNode } from "./runGuardrail";

const baseState = (overrides: Record<string, unknown> = {}) =>
  ({
    businessProfileId: 1,
    channel: "facebook_comment",
    handoffEnabled: true,
    evidence: {
      verifiedActions: [],
      unverifiedActions: [],
      failedActions: [],
      unknownActions: ["integration_action_2"],
    },
    policy: {
      strictBlockOnUnverified: true,
      fallbackTemplates: {
        unverified: "Cannot verify this yet.",
        failed: "Could not verify this.",
        smallTalkRecovery: "Hi.",
      },
    },
    decision: {
      action: "REPLY_AUTO",
      replyType: "NORMAL_REPLY",
      reasoning: "ok",
      publicContent: "",
      privateContent: "We will call you tomorrow with the details.",
      requiresGrounding: false,
      grounded: false,
      usedChunkTypes: [],
      missingInfo: null,
      attachment: null,
    },
    ...overrides,
  }) as any;

describe("runGuardrailNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildAiRecoveryDecisionMock.mockResolvedValue({
      action: "HANDOFF_TO_HUMAN",
      replyType: "SAFE_ACTION_FAILURE",
      reasoning: "Guardrail Triggered: TRUTH_UNKNOWN_ACTION",
      content: "Cannot verify this yet.",
    });
  });

  it("routes unknown action evidence through recovery", async () => {
    const result = await runGuardrailNode(baseState());

    expect(buildAiRecoveryDecisionMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        action: "HANDOFF_TO_HUMAN",
        failureReason: "TRUTH_UNKNOWN_ACTION",
        emergencyFallback: "Cannot verify this yet.",
        allowHandoffLanguage: true,
      }),
    );
    expect(result.decision).toMatchObject({
      replyType: "SAFE_ACTION_FAILURE",
      content: "Cannot verify this yet.",
    });
  });
});
