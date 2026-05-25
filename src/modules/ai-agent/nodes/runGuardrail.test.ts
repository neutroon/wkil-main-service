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
      unknownActions: [],
    },
    policy: {
      strictBlockOnUnverified: true,
      blockPromiseLanguage: true,
      fallbackTemplates: {
        unverified: "Cannot verify this yet.",
        failed: "Could not verify this.",
        unsupportedPromise: "Cannot promise follow-up.",
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
      action: "REPLY_AUTO",
      replyType: "SAFE_ACTION_FAILURE",
      reasoning: "Guardrail Triggered: PROMISE_UNSUPPORTED",
      content: "Cannot promise follow-up.",
    });
  });

  it("checks facebook private/public content, not only content", async () => {
    const result = await runGuardrailNode(baseState());

    expect(buildAiRecoveryDecisionMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        action: "REPLY_AUTO",
        failureReason: "PROMISE_UNSUPPORTED",
        emergencyFallback: "Cannot promise follow-up.",
        allowHandoffLanguage: false,
      }),
    );
    expect(result.decision).toMatchObject({
      replyType: "SAFE_ACTION_FAILURE",
      content: "Cannot promise follow-up.",
    });
  });
});
