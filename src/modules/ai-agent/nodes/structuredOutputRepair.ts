import { logger } from "@utils/logger";
import {
  repairAndParseAiResponse,
  type AiRoutingDecision,
} from "../core/aiEngine.utils";
import type { AgentStateType, SessionStats } from "../core/agentState";
import { addUsageToSessionStats, invokeDecision } from "../core/modelRuntime";

const STRUCTURED_REPAIR_TIMEOUT_MS = 20_000;
const MAX_INVALID_OUTPUT_CHARS = 6_000;

export type StructuredOutputRepairResult = {
  decision: AiRoutingDecision;
  sessionStats: SessionStats;
};

function buildReplyPolicyContext(state: AgentStateType): string {
  if (!state.replyPolicy?.active) return "";
  return [
    "<reply_policy>",
    JSON.stringify(state.replyPolicy, null, 2),
    "Rules:",
    "1. The repaired JSON must use one allowed action and one allowed replyType.",
    "2. If customer correction is required, preserve or produce one concise customer-facing correction question using customerSafeError and correctionFields as the source of truth.",
    "3. Do not confirm action success when canConfirmActionSuccess is false.",
    "4. Do not hand off when canHandoff is false unless the invalid output already contained an explicit customer request for a human.",
    "</reply_policy>",
  ].join("\n");
}

function buildChannelContract(state: AgentStateType): string[] {
  const commonFields = [
    "- action: one of REPLY_AUTO, HANDOFF_TO_HUMAN, RESOLVE_CONVERSATION",
    "- replyType: one of NORMAL_REPLY, ASK_FOR_CORRECTION, CONFIRM_ACTION_SUCCESS, SAFE_ACTION_FAILURE, HANDOFF, RESOLVE",
    "- reasoning: brief internal routing note",
    "- requiresGrounding: boolean",
    "- grounded: boolean",
    "- usedChunkTypes: array of strings",
    "- missingInfo: string or null",
    "- handoffCategory: string or null",
    "- attachment: object with assetName and optional caption, or null",
  ];

  if (state.channel === "facebook_comment") {
    return [
      "Required JSON contract for facebook_comment:",
      ...commonFields,
      "- publicContent: public comment text; preserve the original public-facing text when safe",
      "- privateContent: private message text; preserve the original private-facing text when safe",
      "- intent: one of SALES_DM, GREET_ONLY, IGNORE, NONE",
    ];
  }

  return [
    "Required JSON contract for direct chat:",
    ...commonFields,
    "- content: customer-facing text for direct chat; preserve the original content when safe",
  ];
}

function buildRepairPrompt(params: {
  state: AgentStateType;
  invalidOutput: string;
  parseError: unknown;
}): string {
  const { state, invalidOutput, parseError } = params;
  const parseMessage =
    parseError instanceof Error ? parseError.message : String(parseError);

  return [
    "<structured_output_repair_task>",
    "Rewrite the invalid assistant output into exactly one valid JSON object.",
    "Do not answer the customer again from scratch unless the original customer-facing content is unrecoverable.",
    "Do not call tools, do not include markdown, and do not include text outside the JSON object.",
    "Do not add new business facts, prices, availability, dates, phone numbers, URLs, identifiers, confirmations, bookings, submissions, or delivery claims.",
    "",
    ...buildChannelContract(state),
    "",
    "Repair rules:",
    "1. Preserve the original customer-facing content, action, replyType, grounding fields, usedChunkTypes, missingInfo, handoffCategory, and attachment when they are present and schema-valid.",
    "2. If the output has only small corruption around an otherwise valid JSON object, keep the JSON meaning unchanged.",
    state.channel === "facebook_comment"
      ? "3. If customer-facing content cannot be recovered safely, set publicContent and privateContent to empty strings so the backend can route recovery."
      : "3. If customer-facing content cannot be recovered safely, set content to an empty string so the backend can route recovery.",
    "4. If a factual claim is not explicitly supported by the original output fields, do not mark grounded=true.",
    buildReplyPolicyContext(state),
    "",
    `<parse_error>${parseMessage}</parse_error>`,
    `<channel>${state.channel || "direct"}</channel>`,
    `<available_chunk_types>${JSON.stringify(state.availableChunkTypes || [])}</available_chunk_types>`,
    "",
    "<invalid_assistant_output>",
    invalidOutput.slice(0, MAX_INVALID_OUTPUT_CHARS),
    "</invalid_assistant_output>",
    "</structured_output_repair_task>",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function repairStructuredDecisionOutput(params: {
  state: AgentStateType;
  invalidOutput: string;
  parseError: unknown;
}): Promise<StructuredOutputRepairResult | null> {
  const { state, invalidOutput, parseError } = params;

  try {
    const prompt = buildRepairPrompt({ state, invalidOutput, parseError });
    const repaired = await invokeDecision({
      systemInstruction: "",
      contents: [{ role: "user", content: prompt }],
      channel: state.channel,
      temperature: 0,
      timeoutMs: STRUCTURED_REPAIR_TIMEOUT_MS,
    });

    const repairedText = repaired.rawText.trim();
    const decision = repairAndParseAiResponse(repairedText);

    logger.info("ai.node.structured_output_repair.success", {
      businessProfileId: state.businessProfileId,
      channel: state.channel,
      model: repaired.modelName,
      originalLength: invalidOutput.length,
      repairedLength: repairedText.length,
    });

    return {
      decision,
      sessionStats: addUsageToSessionStats(
        state.sessionStats,
        repaired.usage,
        repaired.modelName,
      ),
    };
  } catch (error: any) {
    logger.warn("ai.node.structured_output_repair.failed", {
      businessProfileId: state.businessProfileId,
      channel: state.channel,
      error: error?.message || String(error),
    });
    return null;
  }
}
