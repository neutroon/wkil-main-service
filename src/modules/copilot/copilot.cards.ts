// src/modules/copilot/copilot.cards.ts
import type { CopilotEnvelope } from "./copilot.types";

export function envelopesForToolResult(toolName: string, result: unknown): CopilotEnvelope[] {
  switch (toolName) {
    case "get_overview": {
      const r = result as any;
      const envs: CopilotEnvelope[] = [];
      if (r?.stats) envs.push({ type: "stat-grid", items: statsItems(r.stats) });
      if (r?.attention) envs.push({ type: "conversation-list", conversations: ((r.attention?.data ?? []) as any[]).map(toConvRow) });
      if (r?.leads) envs.push({ type: "lead-list", leads: r.leads?.data ?? [], total: r.leads?.meta?.total });
      return envs;
    }
    case "get_customer":
      return [{ type: "text", text: formatCustomer((result as any)) }];
    case "get_ai_usage":
      return [{ type: "stat-grid", items: usageItems(result) }];
    default:
      // Unknown tool name — drop silently rather than render a confusing red card.
      // This can happen if the LLM hallucinates a tool name, the deployed backend
      // has stale tool definitions, or the model was trained on an older API
      // version. Either way, the user shouldn't see a broken UI: the LLM should
      // fall back to a text answer (or finalize's fallback text). The actual error
      // is logged at executeTools in copilot.graph.ts when findCopilotTool
      // returns undefined.
      return [];
  }
}

function statsItems(r: any) {
  return [
    { label: "Messages", value: Number(r?.totalMessages ?? 0) },
    { label: "AI automation", value: `${Math.round(Number(r?.aiAutomationRate ?? 0) * 100)}%` },
    { label: "Lead velocity", value: Number(r?.leadVelocity ?? 0) },
    { label: "Avg response", value: String(r?.avgResponseTime ?? "—") },
  ];
}
function usageItems(r: any) {
  return [
    { label: "Total tokens", value: Number(r?.totalTokens ?? 0) },
    { label: "Embedding tokens", value: Number(r?.embeddingTokens ?? 0) },
    { label: "Cost (USD)", value: Number(r?.totalCost ?? 0) },
  ];
}
function toConvRow(c: any) {
  return { id: Number(c?.id ?? 0), customerName: String(c?.name ?? "—"), channel: c?.channel ?? null, handoffCategory: c?.lastHandoffCategory ?? null, preview: c?.preview ?? null };
}
function formatCustomer(c: any) {
  return c?.name ? `${c.name}${c.phone ? ` · ${c.phone}` : ""}` : "Customer not found";
}
