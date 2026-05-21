import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeExternalToolRecoveryRoute } from "@modules/ai-agent/core/modelRuntime";
import { classifyExternalToolFailureRecovery } from "./externalToolRecoveryClassifier";

vi.mock("@modules/ai-agent/core/modelRuntime", () => ({
  invokeExternalToolRecoveryRoute: vi.fn(),
}));

function routeResult(route: "normal_reply" | "handoff", reasoning: string) {
  return {
    route,
    reasoning,
    usage: { promptTokens: 0, completionTokens: 0, groundingCalls: 0 },
    modelName: "test",
    finishReason: "STOP",
  };
}

describe("classifyExternalToolFailureRecovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns normal_reply when the classifier marks the failed tool as non-essential", async () => {
    vi.mocked(invokeExternalToolRecoveryRoute).mockResolvedValue(
      routeResult(
        "normal_reply",
        "The latest message is a greeting and does not need an Agent Action result.",
      ),
    );

    await expect(
      classifyExternalToolFailureRecovery({
        customerMessage: "hi",
        failureReason: "network_or_runtime_error",
      }),
    ).resolves.toBe("normal_reply");
  });

  it("returns handoff when the classifier says the failed action was required", async () => {
    vi.mocked(invokeExternalToolRecoveryRoute).mockResolvedValue(
      routeResult("handoff", "The user requested current price verification."),
    );

    await expect(
      classifyExternalToolFailureRecovery({
        customerMessage: "what is the current subscription price?",
        failureReason: "network_or_runtime_error",
      }),
    ).resolves.toBe("handoff");
  });

  it("defaults to handoff when classifier output is invalid", async () => {
    vi.mocked(invokeExternalToolRecoveryRoute).mockRejectedValue(
      new Error("invalid classifier output"),
    );

    await expect(
      classifyExternalToolFailureRecovery({
        customerMessage: "check my booking",
        failureReason: "network_or_runtime_error",
      }),
    ).resolves.toBe("handoff");
  });
});
