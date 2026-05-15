import { describe, expect, it, vi } from "vitest";

vi.mock("../gemini", () => ({
  genAI: {},
  executeWithFallback: vi.fn(),
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
  buildAiRecoveryDecision: vi.fn(),
}));

import { shouldRejectGeminiOutput } from "./callGemini";

describe("callGeminiNode provider output validation", () => {
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
});
