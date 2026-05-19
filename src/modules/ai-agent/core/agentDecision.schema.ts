import { z } from "zod";

export const aiAttachmentSchema = z.object({
  assetName: z.string(),
  caption: z.string().nullable().optional(),
}).nullable().optional();

export const aiRoutingDecisionSchema = z.object({
  action: z.enum([
    "REPLY_AUTO",
    "HANDOFF_TO_HUMAN",
    "RESOLVE_CONVERSATION",
  ]),
  replyType: z.enum([
    "NORMAL_REPLY",
    "ASK_FOR_CORRECTION",
    "CONFIRM_ACTION_SUCCESS",
    "SAFE_ACTION_FAILURE",
    "HANDOFF",
    "RESOLVE",
  ]),
  handoffCategory: z.string().nullable().optional(),
  reasoning: z.string(),
  content: z.string().optional(),
  intent: z.enum(["SALES_DM", "GREET_ONLY", "IGNORE", "NONE"]).optional(),
  publicContent: z.string().optional(),
  privateContent: z.string().optional(),
  requiresGrounding: z.boolean(),
  grounded: z.boolean(),
  usedChunkTypes: z.array(z.string()),
  missingInfo: z.string().nullable().optional(),
  attachment: aiAttachmentSchema,
});

export const externalToolRecoveryRouteSchema = z.object({
  route: z.enum(["normal_reply", "handoff"]),
  reasoning: z.string(),
});

export type AiRoutingDecisionModelOutput = z.infer<typeof aiRoutingDecisionSchema>;
