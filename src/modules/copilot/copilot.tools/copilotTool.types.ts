import type { z } from "zod";

export type CopilotToolContext = {
  userId: number;
  conversationId: number;
  locale: "ar" | "en";
  onProgress?: (message: string) => void;
};

export interface CopilotToolDefinition {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  requiresConfirmation: boolean;
  handler: (args: any, ctx: CopilotToolContext) => Promise<unknown>;
}
