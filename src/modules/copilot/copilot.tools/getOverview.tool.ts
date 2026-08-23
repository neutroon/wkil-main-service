import { z } from "zod";
import { getUnifiedDashboardStats } from "@modules/analytics/dashboard/dashboard.service";
import { listCustomers } from "@modules/business/customer/customer.service";
import type { CopilotToolDefinition } from "./copilotTool.types";

const SECTION = z.enum(["stats", "leads", "attention"]);

export const getOverviewTool: CopilotToolDefinition = {
  name: "get_overview",
  description:
    "Business overview for the owner. Returns one or more sections: stats (message volume, AI automation, lead velocity, response time), leads (recently captured customers, newest first), attention (conversations waiting for human reply). Call this once with all relevant sections instead of calling separate tools.",
  schema: z.object({
    sections: z.array(SECTION).min(1).max(3).default(["stats", "leads", "attention"]),
    days: z.number().int().min(1).max(90).default(30),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  requiresConfirmation: false,
  handler: async (args, ctx) => {
    const out: Record<string, unknown> = {};
    if (args.sections.includes("stats")) {
      out.stats = await getUnifiedDashboardStats(ctx.userId, "user", args.days);
    }
    if (args.sections.includes("leads")) {
      out.leads = await listCustomers({ userId: ctx.userId, page: 1, limit: args.limit });
    }
    if (args.sections.includes("attention")) {
      out.attention = await listCustomers({ userId: ctx.userId, status: "handoff", page: 1, limit: args.limit });
    }
    return out;
  },
};
