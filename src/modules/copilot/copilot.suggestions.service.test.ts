import { describe, it, expect, vi, beforeEach } from "vitest";
import { getCopilotSuggestions } from "./copilot.suggestions.service";

vi.mock("@modules/ai-agent/core/modelRuntime", () => ({
  invokeText: vi.fn(),
}));

import { invokeText } from "@modules/ai-agent/core/modelRuntime";

const STATIC = [
  { text: "Show me today's numbers" },
  { text: "Any new leads?" },
  { text: "Who needs my attention?" },
];

describe("copilot suggestions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns LLM prompts within word limit and caches", async () => {
    (invokeText as any).mockResolvedValue({
      text: JSON.stringify([{ text: "Today's numbers", why: "morning" }, { text: "Any handoffs?", why: "x" }, { text: "New leads?", why: "y" }]),
    } as any);
    const a = await getCopilotSuggestions({ userId: 1, locale: "en", conversationKind: "GENERAL", hour: 9, recentTitles: [] });
    const b = await getCopilotSuggestions({ userId: 1, locale: "en", conversationKind: "GENERAL", hour: 9, recentTitles: [] });
    expect(a.source).toBe("llm");
    expect(a.prompts.length).toBeGreaterThan(0);
    expect(a.prompts.length).toBeLessThanOrEqual(4);
    a.prompts.forEach((p) => expect(p.text.split(/\s+/).length).toBeLessThanOrEqual(8));
    expect(invokeText).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it("falls back on timeout/error", async () => {
    (invokeText as any).mockRejectedValue(new Error("boom"));
    const out = await getCopilotSuggestions({ userId: 2, locale: "en", conversationKind: "GENERAL", hour: 9, recentTitles: [] });
    expect(out.source).toBe("fallback");
    expect(out.prompts).toEqual(STATIC);
  });
});
