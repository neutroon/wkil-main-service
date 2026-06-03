import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokeText } from "@modules/ai-agent/core/modelRuntime";
import { generateSafeRecoveryReply } from "./aiRecoveryReply";

vi.mock("@modules/ai-agent/core/modelRuntime", () => ({
  invokeText: vi.fn(),
}));

function textResult(text: string) {
  return {
    text,
    usage: { promptTokens: 0, completionTokens: 0, groundingCalls: 0 },
    modelName: "test",
    finishReason: "STOP",
  };
}

describe("generateSafeRecoveryReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses safe AI recovery text when it passes validation", async () => {
    vi.mocked(invokeText).mockResolvedValue(
      textResult("I can’t verify that detail right now. Please send the exact order ID and I’ll check again."),
    );

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
    vi.mocked(invokeText)
      .mockResolvedValueOnce(textResult("Done, your order has been confirmed and saved."))
      .mockResolvedValueOnce(
        textResult("I can’t verify that right now. Please send the exact details so I can check safely."),
      );

    await expect(
      generateSafeRecoveryReply({
        systemInstruction: "Use English.",
        failureReason: "external_lookup_failed",
        safeFallback: "Fallback",
      }),
    ).resolves.toBe(
      "I can’t verify that right now. Please send the exact details so I can check safely.",
    );

    expect(invokeText).toHaveBeenCalledTimes(2);
  });

  it("extracts content when the model accidentally returns JSON", async () => {
    vi.mocked(invokeText).mockResolvedValue(
      textResult(JSON.stringify({
        action: "REPLY_AUTO",
        content: "مش قادر أتحقق من المعلومة دي حالياً. فريقنا هيأكد لك التفاصيل.",
      })),
    );

    await expect(
      generateSafeRecoveryReply({
        systemInstruction: "Voice: Egyptian Arabic",
        failureReason: "external_lookup_failed",
        safeFallback: "Fallback",
        allowHandoffLanguage: true,
      }),
    ).resolves.toBe("مش قادر أتحقق من المعلومة دي حالياً. فريقنا هيأكد لك التفاصيل.");
  });

  it("allows Arabic team confirmation wording when handoff route is active", async () => {
    vi.mocked(invokeText).mockResolvedValue(
      textResult("أنا بخير، شكراً لسؤالك! فريقنا هيتواصل معاك حالاً عشان يتابع معاك."),
    );

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
    vi.mocked(invokeText).mockResolvedValue(
      textResult("أهلاً بيك! فريقنا هيراجع رسالتك وهيتواصل معاك في أسرع وقت."),
    );

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
    vi.mocked(invokeText).mockResolvedValue(
      textResult("Done, your request has been confirmed and saved."),
    );

    await expect(
      generateSafeRecoveryReply({
        systemInstruction: "Use English.",
        failureReason: "external_lookup_failed",
        safeFallback: "Fallback",
        allowHandoffLanguage: true,
      }),
    ).resolves.toBe("Fallback");

    expect(invokeText).toHaveBeenCalledTimes(2);
  });

  it("uses timeoutMs as one total budget across recovery attempts", async () => {
    const nowSpy = vi.spyOn(Date, "now");
    const times = [1_000, 1_000, 1_600];
    nowSpy.mockImplementation(() => times.shift() ?? 1_600);
    vi.mocked(invokeText).mockResolvedValue(
      textResult("Done, your request has been confirmed and saved."),
    );

    try {
      await expect(
        generateSafeRecoveryReply({
          systemInstruction: "Use English.",
          failureReason: "external_lookup_failed",
          safeFallback: "Fallback",
          timeoutMs: 500,
        }),
      ).resolves.toBe("Fallback");
    } finally {
      nowSpy.mockRestore();
    }

    expect(invokeText).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invokeText).mock.calls[0]?.[0]).toMatchObject({
      timeoutMs: 500,
    });
  });
});
