import type { CopilotToolDefinition } from "./copilotTool.types";
import { finishOnboardingTool } from "./finishOnboarding.tool";
import { getAiUsageTool } from "./getAiUsage.tool";
import { getCustomerTool } from "./getCustomer.tool";
import { getOverviewTool } from "./getOverview.tool";
import { saveBusinessInfoTool } from "./saveBusinessInfo.tool";
import { scrapeWebsiteTool } from "./scrapeWebsite.tool";
import { setBrandKitTool } from "./setBrandKit.tool";

export const copilotTools: CopilotToolDefinition[] = [
  getOverviewTool,
  getAiUsageTool,
  getCustomerTool,
  saveBusinessInfoTool,
  scrapeWebsiteTool,
  setBrandKitTool,
  finishOnboardingTool,
];

export function findCopilotTool(name: string): CopilotToolDefinition | undefined {
  return copilotTools.find((t) => t.name === name);
}

export type { CopilotToolDefinition, CopilotToolContext } from "./copilotTool.types";
