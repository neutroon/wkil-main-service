// src/modules/copilot/copilot.cards.test.ts
import { describe, expect, it } from "vitest";
import { envelopesForToolResult } from "./copilot.cards";

describe("envelopesForToolResult", () => {
  it("maps unified stats to a stat-grid", () => {
    const envs = envelopesForToolResult("get_overview_stats", {
      totalMessages: 120, aiAutomationRate: 0.82, leadVelocity: 6, avgResponseTime: "2m",
    });
    expect(envs[0]!.type).toBe("stat-grid");
    expect((envs[0] as any).items.length).toBeGreaterThan(0);
  });

  it("maps customers to a lead-list", () => {
    const envs = envelopesForToolResult("get_leads", {
      data: [{ id: 1, name: "Mona", channel: "whatsapp", createdAt: "2026-08-20" }],
      meta: { total: 1 },
    });
    expect(envs[0]).toMatchObject({ type: "lead-list", leads: [{ id: 1, name: "Mona" }] });
  });

  it("maps handoff customers to a conversation-list", () => {
    const envs = envelopesForToolResult("get_conversations_needing_attention", {
      data: [{ id: 3, name: "Omar", lastHandoffCategory: "complaint" }],
    });
    expect(envs[0]!.type).toBe("conversation-list");
  });

  it("formats a single customer as text", () => {
    const envs = envelopesForToolResult("get_customer", { name: "Yara", phone: "+20…" });
    expect(envs[0]).toMatchObject({ type: "text" });
  });

  it("returns an error envelope for unknown tools", () => {
    const envs = envelopesForToolResult("nope", {});
    expect(envs[0]!.type).toBe("error");
  });
});
