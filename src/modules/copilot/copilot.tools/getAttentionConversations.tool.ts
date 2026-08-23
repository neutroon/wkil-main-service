import { z } from "zod";
import { listCustomers } from "@modules/business/customer/customer.service";
import type { CopilotToolDefinition } from "./copilotTool.types";

export const getAttentionConversationsTool: CopilotToolDefinition = {
  name: "get_conversations_needing_attention",
  description: "List customers/conversations currently waiting for human reply (handoff requested). Use when the owner asks 'who needs me?' or 'pending replies'.",
  schema: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
  requiresConfirmation: false,
  handler: async (args, ctx) => listCustomers({ userId: ctx.userId, status: "handoff", page: 1, limit: args.limit }),
};
