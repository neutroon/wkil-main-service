import { z } from "zod";
import { getAiPerformanceStats } from "@modules/analytics/ai/analytics.service";
import type { CopilotToolDefinition } from "./copilotTool.types";

export const getAiUsageTool: CopilotToolDefinition = {
  name: "get_ai_usage",
  description: "AI usage statistics for the owner/business: token totals, costs, accuracy over a date window.",
  schema: z.object({ days: z.number().int().min(1).max(90).default(30) }),
  requiresConfirmation: false,
  handler: async (args, ctx) => getAiPerformanceStats(String(ctx.userId), "user", args.days),
};
