import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateContent } from "@modules/ai-agent/gemini";
import { generateSafeRecoveryReply } from "./aiRecoveryReply";

vi.mock("@modules/ai-agent/gemini", () => ({
  generateContent: vi.fn(),
}));

describe("generateSafeRecoveryReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it("retries cautiously when AI recovery claims success", async () => {
    vi.mocked(generateContent)
      .mockResolvedValueOnce({
        text: "Done, your order has been confirmed and saved.",
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          groundingCalls: 0,
          model: "test",
        },
      })
      .mockResolvedValueOnce({
        text: "I can’t verify that right now. Please send the exact details so I can check safely.",
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
      "I can’t verify that right now. Please send the exact details so I can check safely.",
    );

    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it("extracts content when the model accidentally returns JSON", async () => {
    vi.mocked(generateContent).mockResolvedValue({
      text: JSON.stringify({
        action: "REPLY_AUTO",
        content: "مش قادر أتحقق من المعلومة دي حالياً. فريقنا هيأكد لك التفاصيل.",
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
      generateSafeRecoveryReply({
        systemInstruction: "Voice: Egyptian Arabic",
        failureReason: "external_lookup_failed",
        safeFallback: "Fallback",
        allowHandoffLanguage: true,
      }),
    ).resolves.toBe("مش قادر أتحقق من المعلومة دي حالياً. فريقنا هيأكد لك التفاصيل.");
  });

  it("rejects handoff promises when no handoff route is active", async () => {
    vi.mocked(generateContent).mockResolvedValue({
      text: "فريقنا هيتواصل معاك في أسرع وقت.",
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
        systemInstruction: "Voice: Egyptian Arabic",
        failureReason: "external_lookup_failed",
        safeFallback: "Fallback",
      }),
    ).resolves.toBe("Fallback");
  });

  it("allows Arabic team confirmation wording when handoff route is active", async () => {
    vi.mocked(generateContent).mockResolvedValue({
      text: "أنا بخير، شكراً لسؤالك! فريقنا هيتواصل معاك حالاً عشان يتابع معاك.",
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
        systemInstruction: "Voice: Egyptian Arabic",
        failureReason: "network_or_runtime_error",
        customerMessage: "how are u",
        safeFallback: "Fallback",
        allowHandoffLanguage: true,
      }),
    ).resolves.toBe(
      "أنا بخير، شكراً لسؤالك! فريقنا هيتواصل معاك حالاً عشان يتابع معاك.",
    );
  });

  it("keeps AI recovery text from real Arabic handoff traces", async () => {
    vi.mocked(generateContent).mockResolvedValue({
      text: "أهلاً بيك! فريقنا هيراجع رسالتك وهيتواصل معاك في أسرع وقت.",
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
        systemInstruction: "Voice: Egyptian Arabic",
        failureReason: "network_or_runtime_error",
        customerMessage: "hi",
        safeFallback: "Fallback",
        allowHandoffLanguage: true,
      }),
    ).resolves.toBe("أهلاً بيك! فريقنا هيراجع رسالتك وهيتواصل معاك في أسرع وقت.");
  });

  it("uses the static emergency fallback only after two unsafe AI recovery attempts", async () => {
    vi.mocked(generateContent).mockResolvedValue({
      text: "Done, your request has been confirmed and saved.",
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
        allowHandoffLanguage: true,
      }),
    ).resolves.toBe("Fallback");

    expect(generateContent).toHaveBeenCalledTimes(2);
  });
});
