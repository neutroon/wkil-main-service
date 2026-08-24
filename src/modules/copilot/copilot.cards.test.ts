// src/modules/copilot/copilot.cards.test.ts
import { describe, expect, it } from "vitest";
import { envelopesForToolResult } from "./copilot.cards";

describe("envelopesForToolResult", () => {
  it("maps get_overview with all 3 sections to stat-grid + conversation-list + lead-list in order", () => {
    const result = {
      stats: { totalMessages: 10, aiAutomationRate: 0.5, leadVelocity: 3, avgResponseTime: "2m" },
      attention: { data: [{ id: 1, name: "Alice", channel: "messenger", lastHandoffCategory: "sales", preview: "hi" }] },
      leads: { data: [{ id: 2, name: "Bob" }], meta: { total: 1 } },
    };
    const envs = envelopesForToolResult("get_overview", result);
    expect(envs).toHaveLength(3);
    expect(envs[0]!.type).toBe("stat-grid");
    expect(envs[1]!.type).toBe("conversation-list");
    expect(envs[2]!.type).toBe("lead-list");
  });

  it("maps get_overview with only stats to a single stat-grid", () => {
    const envs = envelopesForToolResult("get_overview", {
      stats: { totalMessages: 0, aiAutomationRate: 0, leadVelocity: 0, avgResponseTime: "—" },
    });
    expect(envs).toHaveLength(1);
    expect(envs[0]!.type).toBe("stat-grid");
  });

  it("emits 0 envelopes when get_overview has no sections", () => {
    const envs = envelopesForToolResult("get_overview", {});
    expect(envs).toHaveLength(0);
  });

  it("formats a single customer as text", () => {
    const envs = envelopesForToolResult("get_customer", { name: "Yara", phone: "+20…" });
    expect(envs[0]).toMatchObject({ type: "text" });
  });

  it("maps get_ai_usage to a stat-grid", () => {
    const envs = envelopesForToolResult("get_ai_usage", { totalTokens: 100, embeddingTokens: 20, totalCost: 0.01 });
    expect(envs[0]!.type).toBe("stat-grid");
  });

  it("drops unknown tool results silently (no error envelope)", () => {
    // Previously returned `[{ type: "error", message: "Unknown tool result" }]`,
    // which surfaced as red-bordered cards in the UI when the LLM hallucinated
    // tool names. Now returns an empty array — the LLM should fall back to a
    // text answer (or finalize's fallback text). The underlying "unknown tool"
    // error is logged at executeTools in copilot.graph.ts.
    const envs = envelopesForToolResult("nope", {});
    expect(envs).toHaveLength(0);
  });
});
