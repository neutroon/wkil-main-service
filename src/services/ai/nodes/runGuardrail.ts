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
import { logger } from "../../../utils/logger";
import { evaluateGuardrailsForReply } from "../aiEngine.utils";
import type { AgentStateType } from "../agentState";

export async function runGuardrailNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  if (!state.decision) return {};

  const result = evaluateGuardrailsForReply(
    state.evidence,
    state.decision.content || "",
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
  return {
    decision: {
      ...state.decision,
      action:    "REPLY_AUTO",
      reasoning: `Guardrail Triggered: ${result.ruleId}`,
      content:   result.safeReply,
      // Clear channel-specific content fields too
      publicContent:  result.safeReply,
      privateContent: result.safeReply,
    },
  };
}
