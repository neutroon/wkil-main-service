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

const MISSING_KNOWLEDGE_REPLY =
  "I want to confirm this accurately for you. I'll connect you with a team member who can check the latest details.";

function missingKnowledgeDecision(reasoning: string) {
  return {
    action: "HANDOFF_TO_HUMAN" as const,
    handoffCategory: "MISSING_KNOWLEDGE",
    reasoning,
    content: MISSING_KNOWLEDGE_REPLY,
    publicContent: "Thanks! Our team will confirm the details with you.",
    privateContent: MISSING_KNOWLEDGE_REPLY,
    requiresGrounding: true,
    grounded: false,
    usedChunkTypes: [],
  };
}

function hasUnsupportedChunkClaim(
  usedChunkTypes: string[] | undefined,
  availableChunkTypes: string[],
): boolean {
  if (!usedChunkTypes || usedChunkTypes.length === 0) return false;
  const available = new Set(availableChunkTypes);
  return usedChunkTypes.some((chunkType) => !available.has(chunkType));
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

    return {
      decision: missingKnowledgeDecision(
        "AI cited unavailable business context chunk types.",
      ),
    };
  }

  if (
    decision.action !== "HANDOFF_TO_HUMAN" &&
    decision.requiresGrounding === true &&
    state.contextQuality !== "specific_evidence_found"
  ) {
    logger.warn("ai.node.parseDecision.insufficient_context_blocked", {
      businessProfileId: state.businessProfileId,
      channel: state.channel,
      contextQuality: state.contextQuality,
      usedChunkTypes: decision.usedChunkTypes,
    });

    return {
      decision: missingKnowledgeDecision(
        `Specific evidence was not retrieved for a grounded answer. Context quality: ${state.contextQuality ?? "unknown"}`,
      ),
    };
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

    return {
      decision: missingKnowledgeDecision(
        `AI reported missing evidence: ${decision.missingInfo || "No evidence chunks cited."}`,
      ),
    };
  }

  logger.info("ai.node.parseDecision.success", {
    action: decision.action,
    intent: decision.intent,
    requiresGrounding: decision.requiresGrounding,
    grounded: decision.grounded,
    usedChunkTypes: decision.usedChunkTypes,
    businessProfileId: state.businessProfileId,
  });

  return { decision };
}



