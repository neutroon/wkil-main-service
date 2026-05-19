import { describe, expect, it } from "vitest";
import { shouldRejectModelOutput } from "./callModel";

describe("callModelNode provider output validation", () => {
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
});
