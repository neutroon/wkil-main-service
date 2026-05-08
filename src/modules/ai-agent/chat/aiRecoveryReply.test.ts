import { describe, expect, it, vi } from "vitest";
import { generateContent } from "@modules/ai-agent/gemini";
import { generateSafeRecoveryReply } from "./aiRecoveryReply";

vi.mock("@modules/ai-agent/gemini", () => ({
  generateContent: vi.fn(),
}));

describe("generateSafeRecoveryReply", () => {
  it("uses safe AI recovery text when it passes validation", async () => {
    vi.mocked(generateContent).mockResolvedValue({
      text: "I can’t verify that detail right now. Please send the exact order ID and I’ll check again.",
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        groundingCalls: 0,
        model: "test",
      },
    });

    await expect(
      generateSafeRecoveryReply({
        systemInstruction: "Use English.",
        failureReason: "external_lookup_failed",
        safeFallback: "Fallback",
      }),
    ).resolves.toBe(
      "I can’t verify that detail right now. Please send the exact order ID and I’ll check again.",
    );
  });

  it("falls back when AI recovery claims success", async () => {
    vi.mocked(generateContent).mockResolvedValue({
      text: "Done, your order has been confirmed and saved.",
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        groundingCalls: 0,
        model: "test",
      },
    });

    await expect(
      generateSafeRecoveryReply({
        systemInstruction: "Use English.",
        failureReason: "external_lookup_failed",
        safeFallback: "Fallback",
      }),
    ).resolves.toBe("Fallback");
  });
});
