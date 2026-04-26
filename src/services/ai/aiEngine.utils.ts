import { Tool } from "@google/genai";
import { logger } from "../../utils/logger";
import {
  genAI,
  MESSENGER_SAFETY_SETTINGS,
  aiRoutingSchema,
  executeWithFallback,
} from "../../config/gemini";
import { pushLeadToCrm } from "../crm/crm.service";
import { executeExternalQuery } from "../external/externalData.service";
import { recordAiUsage, assertQuotaAvailable } from "../billing.service";
import prisma from "../../config/prisma";
import { AppError } from "../../middlewares/errorHandler.middleware";

type VerificationStatus = "verified" | "unverified" | "failed";

type ToolResultEnvelope = {
  success: boolean;
  verification?: VerificationStatus;
  actionType?: string;
  reason?: string;
  data?: unknown;
};

export type AiTruthfulnessPolicy = {
  strictBlockOnUnverified: boolean;
  blockPromiseLanguage: boolean;
  fallbackTemplates: {
    unverified: string;
    failed: string;
    unsupportedPromise: string;
  };
};

export const DEFAULT_AI_TRUTHFULNESS_POLICY: AiTruthfulnessPolicy = {
  strictBlockOnUnverified: true,
  blockPromiseLanguage: true,
  fallbackTemplates: {
    unverified:
      "I cannot confirm this action yet from the latest system data. Please share the exact required identifier so I can verify it.",
    failed:
      "I could not complete verification due to a system lookup issue. Please recheck the details and send them exactly as provided.",
    unsupportedPromise:
      "I can only confirm actions that were completed and verified in this chat flow. I cannot promise additional actions that were not executed.",
  },
};

type EvidenceState = {
  verifiedActions: string[];
  unverifiedActions: string[];
  failedActions: string[];
  unknownActions: string[];
};

export type AiEvidenceState = EvidenceState;

function makeEmptyEvidence(): EvidenceState {
  return {
    verifiedActions: [],
    unverifiedActions: [],
    failedActions: [],
    unknownActions: [],
  };
}

function resolveTruthfulnessPolicy(
  override?: Partial<AiTruthfulnessPolicy>,
): AiTruthfulnessPolicy {
  if (!override) return DEFAULT_AI_TRUTHFULNESS_POLICY;
  return {
    ...DEFAULT_AI_TRUTHFULNESS_POLICY,
    ...override,
    fallbackTemplates: {
      ...DEFAULT_AI_TRUTHFULNESS_POLICY.fallbackTemplates,
      ...(override.fallbackTemplates || {}),
    },
  };
}

function isVerificationStatus(
  value: unknown,
): value is "verified" | "unverified" | "failed" {
  return value === "verified" || value === "unverified" || value === "failed";
}

export function updateEvidenceFromEnvelope(
  evidence: EvidenceState,
  envelope: ToolResultEnvelope,
  fallbackActionType: string,
): void {
  const actionType = envelope.actionType || fallbackActionType;
  if (!isVerificationStatus(envelope.verification)) {
    evidence.unknownActions.push(actionType);
    return;
  }
  if (envelope.verification === "verified") {
    evidence.verifiedActions.push(actionType);
  } else if (envelope.verification === "unverified") {
    evidence.unverifiedActions.push(actionType);
  } else {
    evidence.failedActions.push(actionType);
  }
}

function hasUnsupportedPromiseLanguage(text: string): boolean {
  return /(?:we will call you|we'll call you|someone will contact you|i have escalated|ticket created|تم\s*التواصل|سنتواصل|سوف\s*نتواصل|تم\s*رفع\s*طلب)/i.test(
    text,
  );
}

export function evaluateGuardrailsForReply(
  evidence: EvidenceState,
  text: string,
  policy: AiTruthfulnessPolicy,
): { blocked: false } | { blocked: true; ruleId: string; safeReply: string } {
  if (evidence.failedActions.length > 0) {
    return {
      blocked: true,
      ruleId: "TRUTH_FAILED_ACTION",
      safeReply: policy.fallbackTemplates.failed,
    };
  }
  if (policy.strictBlockOnUnverified && evidence.unknownActions.length > 0) {
    return {
      blocked: true,
      ruleId: "TRUTH_UNKNOWN_ACTION",
      safeReply: policy.fallbackTemplates.unverified,
    };
  }
  if (policy.strictBlockOnUnverified && evidence.unverifiedActions.length > 0) {
    return {
      blocked: true,
      ruleId: "TRUTH_UNVERIFIED_ACTION",
      safeReply: policy.fallbackTemplates.unverified,
    };
  }
  if (policy.blockPromiseLanguage && hasUnsupportedPromiseLanguage(text)) {
    return {
      blocked: true,
      ruleId: "PROMISE_UNSUPPORTED",
      safeReply: policy.fallbackTemplates.unsupportedPromise,
    };
  }
  return { blocked: false };
}

/**
 * PRODUCTION-GRADE: Resilient JSON parser for LLM outputs.
 * Handles truncated strings by closing quotes/brackets and falling back to regex extraction.
 */
/**
 * PRODUCTION-GRADE: Sanitizes LLM output to prevent 'ghost loops' and 'stuttering'.
 * Removes common invisible unicode characters and heals word-level repetitions.
 */
export function sanitizeAiText(text: string): string {
  if (!text) return "";

  // 1. Remove invisible junk (variation selectors, zero-width spaces, etc.)
  let sanitized = text
    .replace(/[\uFE00-\uFE0F\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // 2. HEAL: Word-level Repetition (Stuttering)
  // Catch phrases or words repeated 3+ times (e.g., "Hello Hello Hello")
  const phrasePattern = /(\b.+?\b)\1{3,}/gi;
  if (phrasePattern.test(sanitized)) {
    logger.warn("ai.engine.stutter_detected", { original: sanitized.substring(0, 100) });
    // Keep the first execution of the pattern, discard the rest
    sanitized = sanitized.replace(phrasePattern, "$1");
  }

  // 3. HEAL: Hard-Truncate extreme length (Backup guard)
  // Most social replies shouldn't exceed 2000 chars unless explicitly long-form
  if (sanitized.length > 5000) {
    logger.warn("ai.engine.excessive_length_truncated", { length: sanitized.length });
    sanitized = sanitized.substring(0, 2000) + "...";
  }

  return sanitized;
}

export function repairAndParseAiResponse(text: string): AiRoutingDecision {
  logger.debug("ai.engine.raw_response_trace", { text });
  let cleaned = text.trim();
  let decision: any = null;

  // 1. Basic JSON Parse
  try {
    decision = JSON.parse(cleaned);
  } catch (e) {
    // 2. Attempt Repair (Mid-stream truncation)
    let repaired = cleaned;
    const doubleQuoteCount = (repaired.match(/"/g) || []).length;
    if (doubleQuoteCount % 2 !== 0) repaired += '"';

    const stack: string[] = [];
    for (const char of repaired) {
      if (char === "{") stack.push("}");
      if (char === "[") stack.push("]");
      if (char === "}" || char === "]") {
        if (stack[stack.length - 1] === char) stack.pop();
      }
    }
    while (stack.length > 0) repaired += stack.pop();

    try {
      decision = JSON.parse(repaired);
    } catch (e2) {
      // 3. Regex Fallback (Final stand)
      const action = cleaned.match(/"action"\s*:\s*"([^"]+)"/)?.[1];
      const reasoning = cleaned.match(/"reasoning"\s*:\s*"([^"]+)"/)?.[1] || "";
      const content = cleaned.match(/"content"\s*:\s*"([^"]+)"/)?.[1] || "";
      const publicContent = cleaned.match(/"publicContent"\s*:\s*"([^"]+)"/)?.[1] || "";
      const privateContent = cleaned.match(/"privateContent"\s*:\s*"([^"]+)"/)?.[1] || "";
      const intent = cleaned.match(/"intent"\s*:\s*"([^"]+)"/)?.[1];

      decision = {
        action: action || "REPLY_AUTO",
        intent: intent || "NONE",
        reasoning,
        content,
        publicContent,
        privateContent,
      };
    }
  }

  // 4. Normalization & Sanitization
  const finalDecision: AiRoutingDecision = {
    action: decision.action || "REPLY_AUTO",
    intent: decision.intent || "NONE",
    reasoning: decision.reasoning || "",
    content: sanitizeAiText(decision.content || ""),
    publicContent: sanitizeAiText(decision.publicContent || ""),
    privateContent: sanitizeAiText(decision.privateContent || ""),
    attachment: decision.attachment,
  };

  // 5. ELITE TIER: Sales Delivery Repairer (Global Fail-Safe)
  // If the intent is SALES_DM but the AI forgot the private text, we MUST repair it.
  if (finalDecision.intent === "SALES_DM" && !finalDecision.privateContent) {
    if (finalDecision.publicContent || finalDecision.content) {
      logger.warn("ai.engine.delivery_gap_repaired", { 
        intent: finalDecision.intent,
        reasoning: finalDecision.reasoning 
      });
      // Append a CTA in Arabic to ensure divergence and brand voice
      const base = finalDecision.publicContent || finalDecision.content;
      finalDecision.privateContent = `${base}\n\nأهلاً بك! ممكن تشاركنا رقم تليفونك أو طلباتك عشان فريقنا يقدر يتواصل معاك بالتفاصيل اللي محتاجها؟`;
    } else {
      // Hard fallback if everything is empty but intent is sales
      finalDecision.privateContent = "أهلاً بك! هبعتلك كل التفاصيل اللي طلبتها دلوقتي. إزاي أقدر أساعدك؟";
    }
  }

  return finalDecision;
}

export function hasExcessiveRepetition(text: string): boolean {
  if (!text || text.length < 50) return false;
  const sanitized = sanitizeAiText(text);
  
  // 1. Character-level loops (aaaaa)
  const charPattern = /(.)\1{9,}/;
  if (charPattern.test(sanitized)) return true;

  // 2. Word-level loops (word word word word)
  const wordPattern = /(\b.+?\b)\s+\1\s+\1\s+\1/gi;
  if (wordPattern.test(sanitized)) return true;

  // 3. Block-level loops (A block of text repeating twice)
  const minBlock = 50;
  const maxBlock = 100;
  const checkLen = Math.min(maxBlock, Math.floor(sanitized.length / 2));
  
  for (let len = minBlock; len <= checkLen; len++) {
    for (let i = 0; i <= sanitized.length - len * 2; i++) {
      const chunk = sanitized.substring(i, i + len);
      const rest = sanitized.substring(i + len);
      if (rest.includes(chunk)) {
        return true;
      }
    }
  }

  return false;
}

export interface AiRoutingDecision {
  action: "REPLY_AUTO" | "HANDOFF_TO_HUMAN" | "RESOLVE_CONVERSATION";
  intent?: "SALES_DM" | "GREET_ONLY" | "IGNORE" | "NONE";
  handoffCategory?: string | null;
  reasoning: string;
  content?: string | null;
  publicContent?: string | null;
  privateContent?: string | null;
  attachment?: { assetName: string; caption?: string | null } | null;
}

