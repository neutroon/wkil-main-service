import { describe, expect, it, vi, beforeEach } from "vitest";
import { generatePendingLookupStatusDecision } from "./pendingLookupStatus";
import { executeWithFallback, genAI } from "@modules/ai-agent/gemini";

vi.mock("@modules/ai-agent/gemini", () => ({
  MESSENGER_SAFETY_SETTINGS: [],
  genAI: {
    models: {
      generateContent: vi.fn(async () => ({
        text: JSON.stringify({
          content: "I’ll check that and update you here.",
          reasoning: "Short contextual pending status.",
        }),
      })),
    },
  },
  executeWithFallback: vi.fn(async (operation: any) => ({
    result: await operation("gemini-test"),
    model: "gemini-test",
  })),
}));

describe("generatePendingLookupStatusDecision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a safe AI routing decision for pending chat-requested actions", async () => {
    const result = await generatePendingLookupStatusDecision({
      businessName: "PagesPilot",
      voice: "English",
      tone: "Friendly",
      channel: "web",
      latestUserText: "Do you have the pro plan available?",
      recentTurns: [
        { role: "user", text: "Hi" },
        { role: "model", text: "Hello, how can I help?" },
        { role: "user", text: "Do you have the pro plan available?" },
      ],
      source: {
        name: "Product availability",
        description: "Checks current product availability.",
      },
    });

    expect(result).toMatchObject({
      action: "REPLY_AUTO",
      content: "I’ll check that and update you here.",
      requiresGrounding: false,
      grounded: true,
      usedChunkTypes: [],
      missingInfo: null,
    });
    expect(executeWithFallback).toHaveBeenCalledWith(
      expect.any(Function),
      "PendingLookupStatus",
      undefined,
      ["gemini-3.1-flash-lite-preview", "gemini-2.5-flash"],
    );
    expect(vi.mocked(genAI.models.generateContent).mock.calls[0][0]).toEqual(
      expect.objectContaining({
        contents: [
          expect.objectContaining({
            parts: [
              expect.objectContaining({
                text: expect.stringContaining(
                  "Recent chat context:\nuser: Hi\nmodel: Hello, how can I help?\nuser: Do you have the pro plan available?",
                ),
              }),
            ],
          }),
        ],
      }),
    );
  });

  it("returns null on status generation failure instead of fallback copy", async () => {
    vi.mocked(executeWithFallback).mockRejectedValueOnce(new Error("timeout"));

    const result = await generatePendingLookupStatusDecision({
      businessName: "PagesPilot",
      latestUserText: "Check availability",
      source: { name: "Availability" },
    });

    expect(result).toBeNull();
  });
});
