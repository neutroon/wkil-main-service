import { z } from "zod";

export const aiAttachmentSchema = z.object({
  assetName: z.string(),
  caption: z.string().nullable().optional(),
}).nullable().optional();

const baseRoutingDecisionSchema = z.object({
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
  requiresGrounding: z.boolean(),
  grounded: z.boolean(),
  usedChunkTypes: z.array(z.string()),
  missingInfo: z.string().nullable().optional(),
  attachment: aiAttachmentSchema,
});

export const directChatRoutingDecisionSchema = baseRoutingDecisionSchema.extend({
  content: z.string(),
});

export const facebookCommentRoutingDecisionSchema = baseRoutingDecisionSchema.extend({
  intent: z.enum(["SALES_DM", "GREET_ONLY", "IGNORE", "NONE"]).optional(),
  publicContent: z.string().optional(),
  privateContent: z.string().optional(),
});

export function getAiRoutingDecisionSchemaForChannel(channel?: string | null) {
  return channel === "facebook_comment"
    ? facebookCommentRoutingDecisionSchema
    : directChatRoutingDecisionSchema;
}

export const externalToolRecoveryRouteSchema = z.object({
  route: z.enum(["normal_reply", "handoff"]),
  reasoning: z.string(),
});
