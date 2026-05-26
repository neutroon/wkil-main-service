/**
 * Node: runGuardrail
 *
 * Evaluates the AI's final decision against the evidence collected from
 * tool executions. Calls the existing pure function:
 * - evaluateGuardrailsForReply()
 *
 * If the guardrail blocks the response, the decision is replaced with
 * a safe, truthful fallback. The original reasoning is preserved in logs.
 *
 * This node only runs when hadToolExecution === true (conditional edge).
 */
import { logger } from "@utils/logger";
import { evaluateGuardrailsForReply } from "../core/aiEngine.utils";
import { buildAiRecoveryDecision } from "./recoveryDecision";
import type { AgentStateType } from "../core/agentState";

export async function runGuardrailNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  if (!state.decision) return {};

  const result = evaluateGuardrailsForReply(
    state.evidence,
    state.policy,
  );

  if (!result.blocked) {
    logger.debug("ai.node.runGuardrail.passed", {
      businessProfileId: state.businessProfileId,
      action: state.decision.action,
    });
    return {}; // Pass-through — decision unchanged
  }

  logger.warn("ai.node.runGuardrail.blocked", {
    businessProfileId: state.businessProfileId,
    channel: state.channel,
    ruleId: result.ruleId,
    evidence: {
      verified:   state.evidence.verifiedActions,
      unverified: state.evidence.unverifiedActions,
      failed:     state.evidence.failedActions,
      unknown:    state.evidence.unknownActions,
    },
  });

  // Override the decision with a safe reply
  const canHandoff = state.handoffEnabled !== false;
  const nextAction = canHandoff && shouldRouteGuardrailToHuman(result.ruleId)
    ? "HANDOFF_TO_HUMAN"
    : "REPLY_AUTO";

  return {
    decision: await buildAiRecoveryDecision(state, {
      action: nextAction,
      handoffCategory:
        nextAction === "HANDOFF_TO_HUMAN"
          ? state.decision.handoffCategory || "MISSING_KNOWLEDGE"
          : null,
      reasoning: `Guardrail Triggered: ${result.ruleId}`,
      failureReason: result.ruleId,
      emergencyFallback: result.safeReply,
      allowHandoffLanguage: nextAction === "HANDOFF_TO_HUMAN",
      requiresGrounding: nextAction === "HANDOFF_TO_HUMAN",
      missingInfo:
        nextAction === "HANDOFF_TO_HUMAN"
          ? "The requested action could not be verified safely."
          : null,
    }),
  };
}

function shouldRouteGuardrailToHuman(ruleId: string): boolean {
  return ruleId === "TRUTH_FAILED_ACTION" || ruleId === "TRUTH_UNKNOWN_ACTION";
}



