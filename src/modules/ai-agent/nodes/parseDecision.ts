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
import { logger } from "@utils/logger";
import {
  repairAndParseAiResponse,
  sanitizeAiText,
  hasExcessiveRepetition,
} from "../core/aiEngine.utils";
import type { AgentStateType } from "../core/agentState";

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
      decision: {
        action: "HANDOFF_TO_HUMAN",
        handoffCategory: "SYSTEM_ERROR",
        reasoning: "AI returned empty response. Requiring human intervention.",
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

  // ── Detect hallucination loops in the final content ───────────────────────
  const contentToCheck = (decision.content || "") + (decision.reasoning || "");
  if (hasExcessiveRepetition(contentToCheck)) {
    // SELF-CORRECTION: If we have turns left, try to let the AI fix itself
    if (state.turnCount < 3) {
      logger.warn("ai.node.parseDecision.requesting_correction", {
        businessProfileId: state.businessProfileId,
        turnCount: state.turnCount,
      });

      return {
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
      };
    }

    // Exhausted retries -> Handoff
    logger.warn("ai.node.parseDecision.repetition_exhausted", {
      businessProfileId: state.businessProfileId,
    });
    return {
      decision: {
        action: "HANDOFF_TO_HUMAN",
        handoffCategory: "AI_LOOP_DETECTED",
        reasoning: "AI response contained excessive repetition after multiple correction attempts.",
        content: "",
      },
    };
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

    return {
      decision: {
        action: "HANDOFF_TO_HUMAN",
        handoffCategory: "SYSTEM_ERROR",
        reasoning: "AI response omitted required direct-message content.",
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



