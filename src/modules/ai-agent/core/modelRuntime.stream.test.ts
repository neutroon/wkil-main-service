import { describe, expect, it, vi } from "vitest";

vi.mock("@utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@modules/admin/ai-pipeline/ai-pipeline.service", () => ({
  getPipelineConfig: vi.fn(async () => ({
    tiers: [{ modelId: "gemini-2.5-flash", provider: "google" }],
    maxOutputTokens: null,
  })),
}));
vi.mock("./aiAgent.runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./aiAgent.runtime")>();
  return { ...actual, apiKeyForProvider: vi.fn(() => undefined) };
});

import { streamDecisionOrTool } from "./modelRuntime";

describe("streamDecisionOrTool", () => {
  it("rejects when the resolved provider is not configured", async () => {
    await expect(
      streamDecisionOrTool({
        systemInstruction: "You are the wkil copilot.",
        contents: [{ role: "user", content: "hi" }],
        tools: [],
        pipeline: "copilot",
        onTextDelta: () => {},
      })
    ).rejects.toThrow(/not configured/i);
  });
});
