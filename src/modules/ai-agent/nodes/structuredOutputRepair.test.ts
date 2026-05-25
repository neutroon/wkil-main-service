import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../core/modelRuntime", () => ({
  invokeDecision: vi.fn(),
  addUsageToSessionStats: (stats: any, usage: any, modelName: string) => ({
    ...stats,
    modelName,
    promptTokens: stats.promptTokens + usage.promptTokens,
    completionTokens: stats.completionTokens + usage.completionTokens,
    groundingCalls: stats.groundingCalls + usage.groundingCalls,
  }),
}));

vi.mock("@utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { invokeDecision } from "../core/modelRuntime";
import { repairStructuredDecisionOutput } from "./structuredOutputRepair";

const baseState = {
  businessProfileId: 1,
  channel: "whatsapp",
  availableChunkTypes: ["identity"],
  sessionStats: {
    promptTokens: 10,
    completionTokens: 5,
    groundingCalls: 0,
    lastBilledPromptTokens: 0,
    lastBilledCompletionTokens: 0,
    lastBilledGrounding: 0,
    modelName: "gemini-3-flash-preview",
  },
} as any;

describe("repairStructuredDecisionOutput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("repairs invalid structured output and carries token usage forward", async () => {
    vi.mocked(invokeDecision).mockResolvedValueOnce({
      modelName: "gemini-3-flash-preview",
      rawText: JSON.stringify({
        action: "REPLY_AUTO",
        replyType: "NORMAL_REPLY",
        reasoning: "Repaired JSON contract.",
        content: "أهلاً بحضرتك.",
        requiresGrounding: false,
        grounded: false,
        usedChunkTypes: [],
        missingInfo: null,
        attachment: null,
      }),
      decision: {
        action: "REPLY_AUTO",
        replyType: "NORMAL_REPLY",
        reasoning: "Repaired JSON contract.",
        content: "أهلاً بحضرتك.",
        requiresGrounding: false,
        grounded: false,
        usedChunkTypes: [],
        missingInfo: null,
        attachment: null,
      },
      usage: {
        promptTokens: 100,
        completionTokens: 25,
        groundingCalls: 0,
      },
      finishReason: "STOP",
    } as any);

    const result = await repairStructuredDecisionOutput({
      state: baseState,
      invalidOutput: '{"action":"REPLY_AUTO"',
      parseError: new Error("AI_RESPONSE_JSON_OBJECT_INCOMPLETE"),
    });

    expect(result?.decision).toMatchObject({
      action: "REPLY_AUTO",
      replyType: "NORMAL_REPLY",
      content: "أهلاً بحضرتك.",
    });
    expect(result?.sessionStats).toMatchObject({
      promptTokens: 110,
      completionTokens: 30,
      modelName: "gemini-3-flash-preview",
    });
  });

  it("uses the facebook comment contract when repairing comment replies", async () => {
    vi.mocked(invokeDecision).mockResolvedValueOnce({
      modelName: "gemini-3-flash-preview",
      rawText: JSON.stringify({
        action: "REPLY_AUTO",
        replyType: "NORMAL_REPLY",
        reasoning: "Repaired facebook comment JSON contract.",
        publicContent: "تمام، بعتنالك التفاصيل.",
        privateContent: "دي تفاصيل البرنامج المطلوبة.",
        intent: "SALES_DM",
        requiresGrounding: false,
        grounded: false,
        usedChunkTypes: [],
        missingInfo: null,
        attachment: null,
      }),
      decision: {
        action: "REPLY_AUTO",
        replyType: "NORMAL_REPLY",
        reasoning: "Repaired facebook comment JSON contract.",
        publicContent: "تمام، بعتنالك التفاصيل.",
        privateContent: "دي تفاصيل البرنامج المطلوبة.",
        intent: "SALES_DM",
        requiresGrounding: false,
        grounded: false,
        usedChunkTypes: [],
        missingInfo: null,
        attachment: null,
      },
      usage: {
        promptTokens: 80,
        completionTokens: 20,
        groundingCalls: 0,
      },
      finishReason: "STOP",
    } as any);

    const result = await repairStructuredDecisionOutput({
      state: {
        ...baseState,
        channel: "facebook_comment",
      },
      invalidOutput: '{"action":"REPLY_AUTO"',
      parseError: new Error("AI_RESPONSE_JSON_OBJECT_INCOMPLETE"),
    });

    const repairPrompt = vi.mocked(invokeDecision).mock.calls[0][0].contents[0].content;
    expect(repairPrompt).toContain("Required JSON contract for facebook_comment");
    expect(repairPrompt).toContain("publicContent: public comment text");
    expect(repairPrompt).toContain("privateContent: private message text");
    expect(repairPrompt).not.toContain("content: customer-facing text for direct chat");
    expect(vi.mocked(invokeDecision).mock.calls[0][0]).toMatchObject({
      channel: "facebook_comment",
    });
    expect(result?.decision).toMatchObject({
      publicContent: "تمام، بعتنالك التفاصيل.",
      privateContent: "دي تفاصيل البرنامج المطلوبة.",
      intent: "SALES_DM",
    });
  });

  it("fails closed when the repair model still returns invalid JSON", async () => {
    vi.mocked(invokeDecision).mockRejectedValueOnce(
      new Error("AI_RESPONSE_JSON_OBJECT_INCOMPLETE"),
    );

    await expect(
      repairStructuredDecisionOutput({
        state: baseState,
        invalidOutput: '{"action":"REPLY_AUTO"',
        parseError: new Error("AI_RESPONSE_JSON_OBJECT_INCOMPLETE"),
      }),
    ).resolves.toBeNull();
  });
});
