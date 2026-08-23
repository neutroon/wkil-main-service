import { z } from "zod";
import { listCustomers } from "@modules/business/customer/customer.service";
import type { CopilotToolDefinition } from "./copilotTool.types";

export const getLeadsTool: CopilotToolDefinition = {
  name: "get_leads",
  description: "List recently captured leads/customers (CRM) for the owner's business, newest first. Optional limit and channel filter.",
  schema: z.object({
    limit: z.number().int().min(1).max(50).default(10),
    channel: z.string().optional(),
  }),
  requiresConfirmation: false,
  handler: async (args, ctx) => {
    const params: any = { userId: ctx.userId, page: 1, limit: args.limit };
    if (args.channel) params.channel = args.channel;
    return listCustomers(params);
  },
};
