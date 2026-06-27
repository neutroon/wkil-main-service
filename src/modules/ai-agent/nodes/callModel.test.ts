import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildAiRecoveryDecisionMock,
  buildImmediateSystemRecoveryDecisionMock,
  invokeDecisionMock,
  invokeDecisionOrToolMock,
  repairStructuredDecisionOutputMock,
} = vi.hoisted(() => ({
  buildAiRecoveryDecisionMock: vi.fn(),
  buildImmediateSystemRecoveryDecisionMock: vi.fn(),
  invokeDecisionMock: vi.fn(),
  invokeDecisionOrToolMock: vi.fn(),
  repairStructuredDecisionOutputMock: vi.fn(),
}));

vi.mock("@utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../core/contextWindow", () => ({
  estimateSystemTokens: vi.fn(() => 0),
  windowContents: vi.fn((contents) => contents),
}));

vi.mock("../core/modelRuntime", () => ({
  addUsageToSessionStats: vi.fn((stats, usage, modelName) => ({
    ...stats,
    modelName,
    promptTokens: stats.promptTokens + usage.promptTokens,
    completionTokens: stats.completionTokens + usage.completionTokens,
    groundingCalls: stats.groundingCalls + usage.groundingCalls,
  })),
  invokeDecision: invokeDecisionMock,
  invokeDecisionOrTool: invokeDecisionOrToolMock,
  isModelStructuredOutputError: vi.fn(() => false),
  isRetryableProviderError: vi.fn(() => false),
}));

vi.mock("./recoveryDecision", () => ({
  buildAiRecoveryDecision: buildAiRecoveryDecisionMock,
  buildImmediateSystemRecoveryDecision: buildImmediateSystemRecoveryDecisionMock,
  buildSystemRecoveryDecision: vi.fn(async () => ({
    action: "HANDOFF_TO_HUMAN",
    replyType: "HANDOFF",
    reasoning: "system recovery",
    content: "",
  })),
}));

vi.mock("./structuredOutputRepair", () => ({
  repairStructuredDecisionOutput: repairStructuredDecisionOutputMock,
}));

import { callModelNode, shouldRejectModelOutput } from "./callModel";

function baseState() {
  return {
    systemInstruction: "System",
    contents: [{ role: "user", content: "ومدير موارد بشرية" }],
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
    turnCount: 0,
  } as any;
}

describe("callModelNode provider output validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildImmediateSystemRecoveryDecisionMock.mockReturnValue({
      action: "HANDOFF_TO_HUMAN",
      replyType: "HANDOFF",
      handoffCategory: "SYSTEM_TIMEOUT",
      reasoning: "deadline recovery",
      content: "failed",
      requiresGrounding: false,
      grounded: false,
      usedChunkTypes: [],
      missingInfo: null,
      attachment: null,
    });
  });

  it("rejects safety-blocked model output before JSON parsing", () => {
    expect(
      shouldRejectModelOutput({
        finishReason: "SAFETY",
        fullText: '{"action":"REPLY_AUTO"',
        functionCallCount: 0,
      }),
    ).toEqual({ reject: true, reason: "SAFETY" });
  });

  it("rejects max-token partial structured replies", () => {
    expect(
      shouldRejectModelOutput({
        finishReason: "MAX_TOKENS",
        fullText: '{"action":"REPLY_AUTO"',
        functionCallCount: 0,
      }),
    ).toEqual({ reject: true, reason: "MAX_TOKENS" });
  });

  it("allows completed structured replies and tool calls", () => {
    expect(
      shouldRejectModelOutput({
        finishReason: "STOP",
        fullText: '{"action":"REPLY_AUTO"}',
        functionCallCount: 0,
      }),
    ).toEqual({ reject: false });

    expect(
      shouldRejectModelOutput({
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

    invokeDecisionMock.mockResolvedValueOnce({
      decision: repairedDecision,
      rawText: '{"action":"REPLY_AUTO","replyType":"NORMAL_REPLY","reasoning":"',
      usage: { promptTokens: 10, completionTokens: 5, groundingCalls: 0 },
      modelName: "gemini-3-flash-preview",
      finishReason: "MAX_TOKENS",
    });
    repairStructuredDecisionOutputMock.mockResolvedValueOnce({
      decision: repairedDecision,
      sessionStats: {
        promptTokens: 11,
        completionTokens: 6,
        groundingCalls: 0,
        lastBilledPromptTokens: 0,
        lastBilledCompletionTokens: 0,
        lastBilledGrounding: 0,
        modelName: "gemini-3-flash-preview",
      },
    });

    const result = await callModelNode(baseState());

    expect(repairStructuredDecisionOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        invalidOutput: expect.stringContaining('"action":"REPLY_AUTO"'),
        parseError: expect.any(Error),
        state: expect.objectContaining({
          sessionStats: expect.objectContaining({
            promptTokens: 10,
            completionTokens: 5,
          }),
        }),
      }),
    );
    expect(buildAiRecoveryDecisionMock).not.toHaveBeenCalled();
    expect(result.decision).toEqual(repairedDecision);
  });

  it("uses one model-native pass when tools are available and no tool is called", async () => {
    invokeDecisionOrToolMock.mockResolvedValueOnce({
      toolCalls: [],
      rawText: JSON.stringify({
        action: "REPLY_AUTO",
        replyType: "NORMAL_REPLY",
        reasoning: "Answered from business context.",
        content: "Hello",
        requiresGrounding: false,
        grounded: true,
        usedChunkTypes: [],
        missingInfo: null,
      }),
      usage: { promptTokens: 10, completionTokens: 5, groundingCalls: 0 },
      modelName: "gemini-3-flash-preview",
      finishReason: "STOP",
    });

    const result = await callModelNode({
      ...baseState(),
      tools: [{ name: "integration_action_2", description: "Tool", schema: {} }],
    });

    expect(invokeDecisionOrToolMock).toHaveBeenCalledOnce();
    expect(invokeDecisionOrToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: undefined,
      }),
    );
    expect(invokeDecisionMock).not.toHaveBeenCalled();
    expect(result.toolCalls).toEqual([]);
    const contents = result.contents || [];
    expect(contents[contents.length - 1]).toMatchObject({
      role: "model",
      content: expect.stringContaining("Answered from business context"),
    });
  });

  it("passes the remaining chat response budget to the model call", async () => {
    invokeDecisionMock.mockResolvedValueOnce({
      decision: {
        action: "REPLY_AUTO",
        replyType: "NORMAL_REPLY",
        reasoning: "Answered from business context.",
        content: "Hello",
        requiresGrounding: false,
        grounded: true,
        usedChunkTypes: [],
        missingInfo: null,
      },
      rawText: '{"action":"REPLY_AUTO"}',
      usage: { promptTokens: 10, completionTokens: 5, groundingCalls: 0 },
      modelName: "gemini-3-flash-preview",
      finishReason: "STOP",
    });

    await callModelNode({
      ...baseState(),
      responseDeadlineAt: Date.now() + 4_000,
    });

    expect(invokeDecisionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: expect.any(Number),
      }),
    );
    expect(invokeDecisionMock.mock.calls[0][0].timeoutMs).toBeGreaterThan(0);
    expect(invokeDecisionMock.mock.calls[0][0].timeoutMs).toBeLessThanOrEqual(3_750);
  });

  it("uses immediate recovery when the chat response deadline is exhausted", async () => {
    const result = await callModelNode({
      ...baseState(),
      responseDeadlineAt: Date.now() + 10,
    });

    expect(invokeDecisionMock).not.toHaveBeenCalled();
    expect(buildImmediateSystemRecoveryDecisionMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        handoffCategory: "SYSTEM_TIMEOUT",
      }),
    );
    expect(buildAiRecoveryDecisionMock).not.toHaveBeenCalled();
    expect(result.decision).toMatchObject({
      action: "HANDOFF_TO_HUMAN",
      handoffCategory: "SYSTEM_TIMEOUT",
    });
  });

  it("uses immediate recovery on provider timeout without calling a recovery model", async () => {
    invokeDecisionMock.mockRejectedValueOnce(new Error("MODEL_TIMEOUT"));

    const result = await callModelNode({
      ...baseState(),
      responseDeadlineAt: Date.now() + 4_000,
    });

    expect(invokeDecisionMock).toHaveBeenCalledOnce();
    expect(buildImmediateSystemRecoveryDecisionMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        handoffCategory: "SYSTEM_TIMEOUT",
      }),
    );
    expect(buildAiRecoveryDecisionMock).not.toHaveBeenCalled();
    expect(result.decision).toMatchObject({
      action: "HANDOFF_TO_HUMAN",
      handoffCategory: "SYSTEM_TIMEOUT",
    });
  });
});
