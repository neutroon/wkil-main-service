import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  executeWithFallbackMock,
  generateContentStreamMock,
  repairStructuredDecisionOutputMock,
  buildAiRecoveryDecisionMock,
} = vi.hoisted(() => ({
  executeWithFallbackMock: vi.fn(),
  generateContentStreamMock: vi.fn(),
  repairStructuredDecisionOutputMock: vi.fn(),
  buildAiRecoveryDecisionMock: vi.fn(),
}));

vi.mock("../gemini", () => ({
  genAI: {
    models: {
      generateContentStream: generateContentStreamMock,
    },
  },
  executeWithFallback: executeWithFallbackMock,
  isRetryableGeminiError: vi.fn(() => false),
  MESSENGER_SAFETY_SETTINGS: [],
  buildAiRoutingSchema: vi.fn(() => ({})),
}));

vi.mock("../core/contextWindow", () => ({
  windowContents: vi.fn((contents) => contents),
  estimateSystemTokens: vi.fn(() => 0),
}));

vi.mock("@modules/billing/billing.service", () => ({
  recordAiUsage: vi.fn(),
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

vi.mock("./structuredOutputRepair", () => ({
  repairStructuredDecisionOutput: repairStructuredDecisionOutputMock,
}));

import { callGeminiNode, shouldRejectGeminiOutput } from "./callGemini";

describe("callGeminiNode provider output validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeWithFallbackMock.mockImplementation(async (runner: any) => ({
      result: await runner("gemini-3-flash-preview"),
      model: "gemini-3-flash-preview",
    }));
  });

  it("rejects safety-blocked Gemini output before JSON parsing", () => {
    expect(
      shouldRejectGeminiOutput({
        finishReason: "SAFETY",
        fullText: '{"action":"REPLY_AUTO"',
        functionCallCount: 0,
      }),
    ).toEqual({ reject: true, reason: "SAFETY" });
  });

  it("rejects max-token partial structured replies", () => {
    expect(
      shouldRejectGeminiOutput({
        finishReason: "MAX_TOKENS",
        fullText: '{"action":"REPLY_AUTO"',
        functionCallCount: 0,
      }),
    ).toEqual({ reject: true, reason: "MAX_TOKENS" });
  });

  it("allows completed structured replies and function calls", () => {
    expect(
      shouldRejectGeminiOutput({
        finishReason: "STOP",
        fullText: '{"action":"REPLY_AUTO"}',
        functionCallCount: 0,
      }),
    ).toEqual({ reject: false });

    expect(
      shouldRejectGeminiOutput({
        finishReason: "MAX_TOKENS",
        fullText: "",
        functionCallCount: 1,
      }),
    ).toEqual({ reject: false });
  });

  it("attempts structured repair before recovery for max-token partial JSON", async () => {
    const repairedDecision = {
      action: "REPLY_AUTO",
      replyType: "NORMAL_REPLY",
      reasoning: "Repaired partial model output.",
      content: "تمام يا فندم، البرنامج مناسب لمجال التدريب والتطوير في الموارد البشرية.",
      requiresGrounding: true,
      grounded: true,
      usedChunkTypes: ["custom_section"],
      missingInfo: null,
    };
    repairStructuredDecisionOutputMock.mockResolvedValue({
      decision: repairedDecision,
      sessionStats: {
        promptTokens: 1,
        completionTokens: 1,
        groundingCalls: 0,
        lastBilledPromptTokens: 0,
        lastBilledCompletionTokens: 0,
        lastBilledGrounding: 0,
        modelName: "gemini-3-flash-preview",
      },
    });
    generateContentStreamMock.mockResolvedValue(
      (async function* () {
        yield {
          candidates: [
            {
              finishReason: "MAX_TOKENS",
              content: {
                parts: [
                  {
                    text: '{"action":"REPLY_AUTO","replyType":"NORMAL_REPLY","reasoning":"',
                  },
                ],
              },
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        };
      })(),
    );

    const result = await callGeminiNode({
      systemInstruction: "System",
      contents: [{ role: "user", parts: [{ text: "ومدير موارد بشرية" }] }],
      tools: undefined,
      businessProfileId: 1,
      channel: "messenger",
      availableChunkTypes: ["custom_section"],
      sessionStats: {
        promptTokens: 0,
        completionTokens: 0,
        groundingCalls: 0,
        lastBilledPromptTokens: 0,
        lastBilledCompletionTokens: 0,
        lastBilledGrounding: 0,
        modelName: "gemini-3-flash-preview",
      },
      policy: {
        fallbackTemplates: {
          unverified: "fallback",
          failed: "failed",
        },
      },
    } as any);

    expect(repairStructuredDecisionOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        invalidOutput: expect.stringContaining('"action":"REPLY_AUTO"'),
        parseError: expect.any(Error),
      }),
    );
    expect(buildAiRecoveryDecisionMock).not.toHaveBeenCalled();
    expect(result.decision).toEqual(repairedDecision);
  });
});
