import { z } from "zod";
import { completeCopilotOnboarding } from "../copilot.store";
import type { CopilotToolDefinition } from "./copilotTool.types";

export const finishOnboardingTool: CopilotToolDefinition = {
  name: "finish_onboarding",
  description:
    "Mark the onboarding interview finished. Flips the conversation to general-copilot mode. Call when the owner has at least connected one channel or says they're ready.",
  schema: z.object({}),
  requiresConfirmation: false,
  handler: async (_args, ctx) => {
    await completeCopilotOnboarding(ctx.conversationId);
    return { done: true };
  },
};
