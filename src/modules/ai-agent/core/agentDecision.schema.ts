import { z } from "zod";
import { toJsonSchema } from "@langchain/core/utils/json_schema";

/**
 * OpenAI strict-mode compatible decision schema.
 *
 * Two constraints come from OpenAI's `response_format: { type: "json_schema",
 * strict: true }` (the default `method` for `withStructuredOutput` on any
 * modern OpenAI model — see `getStructuredOutputMethod` in
 * @langchain/openai):
 *
 *   1. Every property listed in `properties` must also appear in `required`.
 *   2. Every object must set `additionalProperties: false`.
 *
 * Zod v4's `toJSONSchema` already emits `additionalProperties: false` on
 * `z.object(...)`, so (2) is satisfied automatically. For (1), every "this
 * may be absent" field uses `.nullable()` (kept in `required`, accepts
 * `null`) instead of `.optional()` (omitted from `required`).
 *
 * Parsed values therefore have type `T | null` for every previously-optional
 * field; downstream code already treats `null` and "absent" equivalently
 * (see the existing test fixtures).
 */
export const aiAttachmentSchema = z.object({
  assetName: z.string(),
  caption: z.string().nullable(),
}).nullable();

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
  handoffCategory: z.string().nullable(),
  reasoning: z.string(),
  requiresGrounding: z.boolean(),
  grounded: z.boolean(),
  usedChunkTypes: z.array(z.string()),
  missingInfo: z.string().nullable(),
  attachment: aiAttachmentSchema,
});

export const directChatRoutingDecisionSchema = baseRoutingDecisionSchema.extend({
  content: z.string(),
});

export const facebookCommentRoutingDecisionSchema = baseRoutingDecisionSchema.extend({
  intent: z.enum(["SALES_DM", "GREET_ONLY", "IGNORE", "NONE"]).nullable(),
  publicContent: z.string().nullable(),
  privateContent: z.string().nullable(),
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

/**
 * The OpenAI-strict-compatible JSON Schema for a given channel. This is
 * what gets sent to OpenAI as `response_format.json_schema.schema` when the
 * default `method: "jsonSchema"` is used. The test below asserts that
 * every object has `additionalProperties: false` and every property is
 * listed in `required` — which is the contract OpenAI enforces.
 */
export function getAiRoutingDecisionJsonSchemaForChannel(
  channel?: string | null,
) {
  return toJsonSchema(getAiRoutingDecisionSchemaForChannel(channel));
}
