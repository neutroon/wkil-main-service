/**
 * Node: parseDecision
 *
 * Parses the raw text from Gemini's latest response into a typed
 * AiRoutingDecision. Calls the existing battle-tested pure functions:
 * - repairAndParseAiResponse()
 * - sanitizeAiText()
 *
 * These pure functions are NOT replaced — they are kept as-is and simply
 * called from this thin wrapper node.
 */
import { logger } from "../../../utils/logger";
import {
  repairAndParseAiResponse,
  sanitizeAiText,
  hasExcessiveRepetition,
} from "../aiEngine.service";
import type { AgentStateType } from "../agentState";

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

  if (!responseText) {
    logger.warn("ai.node.parseDecision.empty_response", {
      businessProfileId: state.businessProfileId,
      turnCount: state.turnCount,
    });
    return {
      decision: {
        action: "HANDOFF_TO_HUMAN",
        handoffCategory: "SYSTEM_ERROR",
        reasoning: "AI returned empty response. Requiring human intervention.",
        content: "",
      },
    };
  }

  // ── Detect hallucination loops before parsing ─────────────────────────────
  if (hasExcessiveRepetition(responseText)) {
    logger.warn("ai.node.parseDecision.repetition_detected", {
      businessProfileId: state.businessProfileId,
      preview: responseText.substring(0, 100),
    });
    return {
      decision: {
        action: "HANDOFF_TO_HUMAN",
        handoffCategory: "AI_LOOP_DETECTED",
        reasoning: "AI response contained excessive repetition (hallucination guard).",
        content: "",
      },
    };
  }

  // ── Parse using the existing resilient 3-stage parser ────────────────────
  let decision;
  try {
    decision = repairAndParseAiResponse(responseText);
  } catch (parseError: any) {
    logger.error("ai.node.parseDecision.parse_failed", {
      error: parseError.message,
      businessProfileId: state.businessProfileId,
    });
    return {
      decision: {
        action: "HANDOFF_TO_HUMAN",
        handoffCategory: "SYSTEM_ERROR",
        reasoning: "AI response parsing failed (potential mid-stream truncation).",
        content: "",
      },
    };
  }

  logger.info("ai.node.parseDecision.success", {
    action: decision.action,
    intent: decision.intent,
    businessProfileId: state.businessProfileId,
  });

  return { decision };
}
