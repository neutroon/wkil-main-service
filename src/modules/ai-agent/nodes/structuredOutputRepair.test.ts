import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../gemini", () => ({
  buildAiRoutingSchema: vi.fn(() => ({ type: "OBJECT" })),
  executeWithFallback: vi.fn(),
  genAI: {
    models: {
      generateContent: vi.fn(),
    },
  },
  MESSENGER_SAFETY_SETTINGS: [],
}));

vi.mock("@utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { executeWithFallback } from "../gemini";
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
    vi.mocked(executeWithFallback).mockResolvedValueOnce({
      model: "gemini-3-flash-preview",
      result: {
        text: JSON.stringify({
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
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 25,
        },
      },
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

  it("fails closed when the repair model still returns invalid JSON", async () => {
    vi.mocked(executeWithFallback).mockResolvedValueOnce({
      model: "gemini-3-flash-preview",
      result: {
        text: '{"action":"REPLY_AUTO"',
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 25,
        },
      },
    } as any);

    await expect(
      repairStructuredDecisionOutput({
        state: baseState,
        invalidOutput: '{"action":"REPLY_AUTO"',
        parseError: new Error("AI_RESPONSE_JSON_OBJECT_INCOMPLETE"),
      }),
    ).resolves.toBeNull();
  });
});
