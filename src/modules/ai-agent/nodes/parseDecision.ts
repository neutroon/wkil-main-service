/**
 * Node: parseDecision
 *
 * Parses the raw text from Gemini's latest response into a typed
 * AiRoutingDecision. It keeps parsing strict, then uses one bounded
 * structured-output repair attempt before falling back to safe recovery.
 * Calls the existing pure functions:
 * - repairAndParseAiResponse()
 * - sanitizeAiText()
 */
import { logger } from "@utils/logger";
import {
  repairAndParseAiResponse,
  sanitizeAiText,
  hasExcessiveRepetition,
} from "../core/aiEngine.utils";
import {
  buildAiRecoveryDecision,
  buildMissingKnowledgeDecision,
  buildSystemRecoveryDecision,
} from "./recoveryDecision";
import { validateDecisionAgainstReplyPolicy } from "../core/replyPolicy";
import type { AgentStateType } from "../core/agentState";
import { repairStructuredDecisionOutput } from "./structuredOutputRepair";

function hasUnsupportedChunkClaim(
  usedChunkTypes: string[] | undefined,
  availableChunkTypes: string[],
): boolean {
  if (!usedChunkTypes || usedChunkTypes.length === 0) return false;
  const available = new Set(availableChunkTypes);
  return usedChunkTypes.some((chunkType) => !available.has(chunkType));
}

function hasSupportedGroundingEvidence(
  usedChunkTypes: string[] | undefined,
  availableChunkTypes: string[],
): boolean {
  if (!usedChunkTypes || usedChunkTypes.length === 0) return false;
  const available = new Set(availableChunkTypes);
  return usedChunkTypes.every((chunkType) => available.has(chunkType));
}

function replyPolicyCorrectionPrompt(state: AgentStateType, reason: string): string {
  const policy = state.replyPolicy;
  return [
    "CRITIQUE: The previous JSON did not satisfy the active reply_policy.",
    `Policy violation: ${reason}`,
    policy ? `Allowed replyTypes: ${policy.allowedReplyTypes.join(", ")}.` : "",
    policy ? `Allowed actions: ${policy.allowedActions.join(", ")}.` : "",
    policy?.requiresCustomerCorrection
      ? "Ask exactly one concise customer-facing question for the corrected field from correctionFields."
      : "",
    policy?.customerSafeError ? `Customer-safe error detail: ${policy.customerSafeError}` : "",
    "Return exactly one JSON object that matches the response schema.",
  ].filter(Boolean).join(" ");
}

export async function parseDecisionNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  // Extract the last model turn's text content
  const lastModelTurn = [...state.contents]
    .reverse()
    .find((c) => c.role === "model");

  const responseText = (lastModelTurn?.parts ?? [])
    .filter((p) => p.text)
    .map((p) => p.text!)
    .join("")
    .trim();

  logger.debug("ai.node.parseDecision.text_received", {
    length: responseText.length,
    preview: responseText.substring(0, 50) + "..."
  });

  if (!responseText) {
    logger.warn("ai.node.parseDecision.empty_response", {
      businessProfileId: state.businessProfileId,
      turnCount: state.turnCount,
    });
    return {
      decision: await buildSystemRecoveryDecision(state, {
        reasoning: "AI returned empty response. Requiring human intervention.",
        failureReason: "empty_ai_response",
      }),
    };
  }

  // ── Parse strictly, then run one bounded structured-output repair if needed.
  let decision;
  let repairedSessionStats: AgentStateType["sessionStats"] | undefined;
  const withRepairedStats = (
    updates: Partial<AgentStateType>,
  ): Partial<AgentStateType> =>
    repairedSessionStats
      ? { ...updates, sessionStats: repairedSessionStats }
      : updates;

  try {
    decision = repairAndParseAiResponse(responseText);
  } catch (parseError: any) {
    logger.error("ai.node.parseDecision.parse_failed", {
      error: parseError.message,
      businessProfileId: state.businessProfileId,
    });

    const repaired = await repairStructuredDecisionOutput({
      state,
      invalidOutput: responseText,
      parseError,
    });
    if (repaired) {
      decision = repaired.decision;
      repairedSessionStats = repaired.sessionStats;
      state = {
        ...state,
        sessionStats: repaired.sessionStats,
      };
    } else {
      return {
        decision: await buildSystemRecoveryDecision(state, {
          reasoning:
            "AI response parsing failed and structured self-repair could not recover a valid routing decision.",
          failureReason: "ai_response_parse_failed",
        }),
      };
    }
  }

  // ── Detect hallucination loops in the final content ───────────────────────
  const contentToCheck = (decision.content || "") + (decision.reasoning || "");
  if (hasExcessiveRepetition(contentToCheck)) {
    // SELF-CORRECTION: If we have turns left, try to let the AI fix itself
    if (state.turnCount < 3) {
      logger.warn("ai.node.parseDecision.requesting_correction", {
        businessProfileId: state.businessProfileId,
        turnCount: state.turnCount,
      });

      return withRepairedStats({
        // Request a retry by setting decision to null
        decision: null as any,
        // Inject the correction prompt as a new user turn explicitly
        contents: [
          ...state.contents,
          {
            role: "user",
            parts: [{ text: "CRITIQUE: You repeated yourself in the last turn. Please provide a fresh, non-repetitive response and ensure you are not stuck in a loop." }]
          }
        ]
      });
    }

    // Exhausted retries -> Handoff
    logger.warn("ai.node.parseDecision.repetition_exhausted", {
      businessProfileId: state.businessProfileId,
    });
    return withRepairedStats({
      decision: await buildSystemRecoveryDecision(state, {
        reasoning: "AI response contained excessive repetition after multiple correction attempts.",
        failureReason: "ai_loop_detected",
        handoffCategory: "AI_LOOP_DETECTED",
      }),
    });
  }

  const replyPolicyValidation = validateDecisionAgainstReplyPolicy({
    decision,
    policy: state.replyPolicy,
  });
  if (!replyPolicyValidation.ok) {
    if (state.turnCount < 3) {
      logger.warn("ai.node.parseDecision.reply_policy_blocked", {
        businessProfileId: state.businessProfileId,
        turnCount: state.turnCount,
        action: decision.action,
        replyType: decision.replyType,
        reason: replyPolicyValidation.reason,
      });

      return withRepairedStats({
        decision: null as any,
        contents: [
          ...state.contents,
          {
            role: "user",
            parts: [{ text: replyPolicyCorrectionPrompt(state, replyPolicyValidation.reason) }],
          },
        ],
      });
    }

    logger.warn("ai.node.parseDecision.reply_policy_exhausted", {
      businessProfileId: state.businessProfileId,
      action: decision.action,
      replyType: decision.replyType,
      reason: replyPolicyValidation.reason,
    });

    return withRepairedStats({
      decision: await buildAiRecoveryDecision(state, {
        action: "REPLY_AUTO",
        reasoning:
          "AI reply violated the active reply policy after correction attempts.",
        failureReason: "reply_policy_violation",
        emergencyFallback: state.policy.fallbackTemplates.unverified,
        allowHandoffLanguage: false,
        requiresGrounding: false,
        missingInfo:
          state.replyPolicy?.customerSafeError ||
          "The active reply policy could not be satisfied safely.",
      }),
    });
  }

  const isDirectChannel =
    state.channel === "web" ||
    state.channel === "whatsapp" ||
    state.channel === "messenger";
  if (
    isDirectChannel &&
    decision.action !== "HANDOFF_TO_HUMAN" &&
    (typeof decision.content !== "string" || decision.content.trim() === "")
  ) {
    logger.warn("ai.node.parseDecision.missing_dm_content", {
      businessProfileId: state.businessProfileId,
      channel: state.channel,
      action: decision.action,
    });

    return withRepairedStats({
      decision: await buildSystemRecoveryDecision(state, {
        reasoning: "AI response omitted required direct-message content.",
        failureReason: "missing_direct_message_content",
      }),
    });
  }

  if (
    decision.action !== "HANDOFF_TO_HUMAN" &&
    decision.requiresGrounding === true &&
    hasUnsupportedChunkClaim(decision.usedChunkTypes, state.availableChunkTypes)
  ) {
    logger.warn("ai.node.parseDecision.invalid_grounding_claim_blocked", {
      businessProfileId: state.businessProfileId,
      channel: state.channel,
      usedChunkTypes: decision.usedChunkTypes,
      availableChunkTypes: state.availableChunkTypes,
    });

    return withRepairedStats({
      decision: await buildMissingKnowledgeDecision(
        state,
        "AI cited unavailable business context chunk types.",
      ),
    });
  }

  if (
    decision.action !== "HANDOFF_TO_HUMAN" &&
    decision.requiresGrounding === true &&
    state.contextQuality !== "specific_evidence_found" &&
    !hasSupportedGroundingEvidence(decision.usedChunkTypes, state.availableChunkTypes)
  ) {
    logger.warn("ai.node.parseDecision.insufficient_context_blocked", {
      businessProfileId: state.businessProfileId,
      channel: state.channel,
      contextQuality: state.contextQuality,
      usedChunkTypes: decision.usedChunkTypes,
    });

    return withRepairedStats({
      decision: await buildMissingKnowledgeDecision(
        state,
        `Specific evidence was not retrieved for a grounded answer. Context quality: ${state.contextQuality ?? "unknown"}`,
      ),
    });
  }

  if (
    decision.action !== "HANDOFF_TO_HUMAN" &&
    decision.requiresGrounding === true &&
    (decision.grounded === false || decision.usedChunkTypes?.length === 0)
  ) {
    logger.warn("ai.node.parseDecision.ungrounded_response_blocked", {
      businessProfileId: state.businessProfileId,
      channel: state.channel,
      action: decision.action,
      missingInfo: decision.missingInfo,
      usedChunkTypes: decision.usedChunkTypes,
    });

    return withRepairedStats({
      decision: await buildMissingKnowledgeDecision(
        state,
        `AI reported missing evidence: ${decision.missingInfo || "No evidence chunks cited."}`,
      ),
    });
  }

  logger.info("ai.node.parseDecision.success", {
    action: decision.action,
    intent: decision.intent,
    requiresGrounding: decision.requiresGrounding,
    grounded: decision.grounded,
    usedChunkTypes: decision.usedChunkTypes,
    businessProfileId: state.businessProfileId,
  });

  return withRepairedStats({ decision });
}



