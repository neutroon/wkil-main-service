import { z } from "zod";
import { getUnifiedDashboardStats } from "@modules/analytics/dashboard/dashboard.service";
import type { CopilotToolDefinition } from "./copilotTool.types";

export const getOverviewStatsTool: CopilotToolDefinition = {
  name: "get_overview_stats",
  description: "Business overview for the owner: message volume, AI automation rate, lead velocity, response time and channel health over the last N days.",
  schema: z.object({ days: z.number().int().min(1).max(90).default(30) }),
  requiresConfirmation: false,
  handler: async (args, ctx) => getUnifiedDashboardStats(ctx.userId, "user", args.days),
};
