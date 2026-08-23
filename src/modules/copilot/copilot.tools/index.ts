import type { CopilotToolDefinition } from "./copilotTool.types";
import { getAiUsageTool } from "./getAiUsage.tool";
import { getAttentionConversationsTool } from "./getAttentionConversations.tool";
import { getCustomerTool } from "./getCustomer.tool";
import { getLeadsTool } from "./getLeads.tool";
import { getOverviewStatsTool } from "./getOverviewStats.tool";

export const copilotTools: CopilotToolDefinition[] = [
  getOverviewStatsTool,
  getLeadsTool,
  getAttentionConversationsTool,
  getCustomerTool,
  getAiUsageTool,
];

export function findCopilotTool(name: string): CopilotToolDefinition | undefined {
  return copilotTools.find((t) => t.name === name);
}

export type { CopilotToolDefinition, CopilotToolContext } from "./copilotTool.types";
