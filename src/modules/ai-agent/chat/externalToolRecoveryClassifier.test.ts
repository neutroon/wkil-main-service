import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateContent } from "@modules/ai-agent/gemini";
import { classifyExternalToolFailureRecovery } from "./externalToolRecoveryClassifier";

vi.mock("@modules/ai-agent/gemini", () => ({
  generateContent: vi.fn(),
}));

describe("classifyExternalToolFailureRecovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns normal_reply when the classifier marks the failed tool as non-essential", async () => {
    vi.mocked(generateContent).mockResolvedValue({
      text: JSON.stringify({
        route: "normal_reply",
        reasoning: "The latest message is a greeting and does not need an Agent Action result.",
      }),
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        groundingCalls: 0,
        model: "test",
      },
    });

    await expect(
      classifyExternalToolFailureRecovery({
        customerMessage: "hi",
        failureReason: "network_or_runtime_error",
      }),
    ).resolves.toBe("normal_reply");
  });

  it("returns handoff when the classifier says the failed action was required", async () => {
    vi.mocked(generateContent).mockResolvedValue({
      text: JSON.stringify({
        route: "handoff",
        reasoning: "The user requested current price verification.",
      }),
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        groundingCalls: 0,
        model: "test",
      },
    });

    await expect(
      classifyExternalToolFailureRecovery({
        customerMessage: "what is the current subscription price?",
        failureReason: "network_or_runtime_error",
      }),
    ).resolves.toBe("handoff");
  });

  it("defaults to handoff when classifier output is invalid", async () => {
    vi.mocked(generateContent).mockResolvedValue({
      text: "not-json",
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        groundingCalls: 0,
        model: "test",
      },
    });

    await expect(
      classifyExternalToolFailureRecovery({
        customerMessage: "check my booking",
        failureReason: "network_or_runtime_error",
      }),
    ).resolves.toBe("handoff");
  });
});
