import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@modules/ai-agent/chat/aiRecoveryReply", () => ({
  generateSafeRecoveryReply: vi.fn(async () => "Recovery reply."),
}));

import { generateSafeRecoveryReply } from "@modules/ai-agent/chat/aiRecoveryReply";
import { buildAiRecoveryDecision } from "./recoveryDecision";

const baseState = (overrides: Record<string, unknown> = {}) =>
  ({
    systemInstruction: "System prompt",
    channel: "messenger",
    contents: [{ role: "user", content: "latest customer message" }],
    ...overrides,
  }) as any;

const baseParams = {
  action: "REPLY_AUTO" as const,
  reasoning: "Recovery needed.",
  failureReason: "test_failure",
  emergencyFallback: "Fallback reply.",
};

describe("buildAiRecoveryDecision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateSafeRecoveryReply).mockResolvedValue("Recovery reply.");
  });

  it("returns direct-chat recovery content without comment fields", async () => {
    const decision = await buildAiRecoveryDecision(baseState(), baseParams);

    expect(decision).toMatchObject({
      action: "REPLY_AUTO",
      replyType: "SAFE_ACTION_FAILURE",
      content: "Recovery reply.",
    });
    expect(decision?.publicContent).toBeUndefined();
    expect(decision?.privateContent).toBeUndefined();
    expect(decision?.intent).toBeUndefined();
  });

  it("returns facebook-comment recovery content without direct content", async () => {
    const decision = await buildAiRecoveryDecision(
      baseState({ channel: "facebook_comment" }),
      baseParams,
    );

    expect(decision).toMatchObject({
      action: "REPLY_AUTO",
      replyType: "SAFE_ACTION_FAILURE",
      publicContent: "Recovery reply.",
      privateContent: "",
      intent: "NONE",
    });
    expect(decision?.content).toBeUndefined();
  });
});
