import { z } from "zod";
import { analyzeWebsiteForUser } from "@modules/scraping/scraping.service";
import { setCopilotOnboardingStep } from "../copilot.store";
import type { CopilotToolDefinition } from "./copilotTool.types";

export const scrapeWebsiteTool: CopilotToolDefinition = {
  name: "scrape_website",
  description:
    "Scrape the owner's website and extract brand identity, products, and policies. Used during onboarding after business info is saved. Long-running (multi-page).",
  schema: z.object({ url: z.string().url() }),
  requiresConfirmation: false,
  handler: async (args, ctx) => {
    ctx.onProgress?.("Analyzing your website…");
    const result = await analyzeWebsiteForUser(ctx.userId, args.url);
    await setCopilotOnboardingStep(ctx.conversationId, "kb_review");
    return result;
  },
};
