import { logger } from "@utils/logger";
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
  fallbackTemplates: {
    unverified: string;
    failed: string;
    smallTalkRecovery: string;
  };
};

export const DEFAULT_AI_TRUTHFULNESS_POLICY: AiTruthfulnessPolicy = {
  strictBlockOnUnverified: true,
  fallbackTemplates: {
    unverified:
      "I cannot confirm this action yet from the latest system data. Please share the exact required identifier so I can verify it.",
    failed:
      "I could not complete verification due to a system lookup issue. Please recheck the details and send them exactly as provided.",
    smallTalkRecovery:
      "Hi! How can I help you today?",
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

export function evaluateGuardrailsForReply(
  evidence: EvidenceState,
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
  return { blocked: false };
}

/**
 * PRODUCTION-GRADE: Sanitizes LLM output to prevent 'ghost loops' and 'stuttering'.
 * Removes common invisible unicode characters and heals word-level repetitions.
 */
export function sanitizeAiText(text: string): string {
  if (!text) return "";

  // 1. Remove invisible junk (variation selectors, zero-width spaces, etc.)
  let sanitized = text
    .replace(/[\uFE00-\uFE0F\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // 2. HEAL: Word-level Repetition (Stuttering)
  // Catch phrases or words repeated 3+ times (e.g., "Hello Hello Hello")
  const phrasePattern = /(\b.+?\b)\1{3,}/gi;
  if (phrasePattern.test(sanitized)) {
    logger.warn("ai.engine.stutter_detected", {
      original: sanitized.substring(0, 100),
    });
    // Keep the first execution of the pattern, discard the rest
    sanitized = sanitized.replace(phrasePattern, "$1");
  }

  // 3. HEAL: Hard-Truncate extreme length (Backup guard)
  // Most social replies shouldn't exceed 2000 chars unless explicitly long-form
  if (sanitized.length > 5000) {
    logger.warn("ai.engine.excessive_length_truncated", {
      length: sanitized.length,
    });
    sanitized = sanitized.substring(0, 2000) + "...";
  }

  return sanitized;
}

function extractJsonObjectCandidate(text: string): string {
  const trimmed = text.trim();
  const firstBrace = trimmed.indexOf("{");
  if (firstBrace < 0) {
    throw new Error("AI_RESPONSE_JSON_OBJECT_NOT_FOUND");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = firstBrace; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) {
        return trimmed.slice(firstBrace, i + 1).trim();
      }
    }
  }

  throw new Error("AI_RESPONSE_JSON_OBJECT_INCOMPLETE");
}

const VALID_ACTIONS = new Set([
  "REPLY_AUTO",
  "HANDOFF_TO_HUMAN",
  "RESOLVE_CONVERSATION",
]);

const VALID_REPLY_TYPES = new Set([
  "NORMAL_REPLY",
  "ASK_FOR_CORRECTION",
  "CONFIRM_ACTION_SUCCESS",
  "SAFE_ACTION_FAILURE",
  "HANDOFF",
  "RESOLVE",
]);

const VALID_INTENTS = new Set(["SALES_DM", "GREET_ONLY", "IGNORE", "NONE"]);

function assertStringField(
  value: Record<string, unknown>,
  field: string,
): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string") {
    throw new Error(`AI_RESPONSE_SCHEMA_INVALID:${field}`);
  }
  return fieldValue;
}

function assertBooleanField(
  value: Record<string, unknown>,
  field: string,
): boolean {
  const fieldValue = value[field];
  if (typeof fieldValue !== "boolean") {
    throw new Error(`AI_RESPONSE_SCHEMA_INVALID:${field}`);
  }
  return fieldValue;
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" ? sanitizeAiText(value) : null;
}

function normalizeAttachment(value: unknown): AiRoutingDecision["attachment"] {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI_RESPONSE_SCHEMA_INVALID:attachment");
  }

  const attachment = value as Record<string, unknown>;
  if (typeof attachment.assetName !== "string" || !attachment.assetName.trim()) {
    throw new Error("AI_RESPONSE_SCHEMA_INVALID:attachment.assetName");
  }
  if (
    attachment.caption !== undefined &&
    attachment.caption !== null &&
    typeof attachment.caption !== "string"
  ) {
    throw new Error("AI_RESPONSE_SCHEMA_INVALID:attachment.caption");
  }

  return {
    assetName: attachment.assetName,
    caption:
      typeof attachment.caption === "string" ? attachment.caption : null,
  };
}

function normalizeParsedDecision(value: unknown): AiRoutingDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI_RESPONSE_SCHEMA_INVALID:root");
  }

  const decision = value as Record<string, unknown>;
  const action = assertStringField(decision, "action");
  if (!VALID_ACTIONS.has(action)) {
    throw new Error("AI_RESPONSE_SCHEMA_INVALID:action");
  }

  const replyType = assertStringField(decision, "replyType");
  if (!VALID_REPLY_TYPES.has(replyType)) {
    throw new Error("AI_RESPONSE_SCHEMA_INVALID:replyType");
  }

  const intent =
    typeof decision.intent === "string" && VALID_INTENTS.has(decision.intent)
      ? decision.intent
      : "NONE";

  const usedChunkTypes = decision.usedChunkTypes;
  if (!Array.isArray(usedChunkTypes)) {
    throw new Error("AI_RESPONSE_SCHEMA_INVALID:usedChunkTypes");
  }

  const finalDecision: AiRoutingDecision = {
    action: action as AiRoutingDecision["action"],
    replyType: replyType as AiRoutingDecision["replyType"],
    intent: intent as AiRoutingDecision["intent"],
    reasoning: sanitizeAiText(assertStringField(decision, "reasoning")),
    content: sanitizeAiText(
      typeof decision.content === "string" ? decision.content : "",
    ),
    publicContent: sanitizeAiText(
      typeof decision.publicContent === "string" ? decision.publicContent : "",
    ),
    privateContent: sanitizeAiText(
      typeof decision.privateContent === "string" ? decision.privateContent : "",
    ),
    requiresGrounding: assertBooleanField(decision, "requiresGrounding"),
    grounded: assertBooleanField(decision, "grounded"),
    usedChunkTypes: usedChunkTypes.filter(
      (item): item is string => typeof item === "string",
    ),
    missingInfo: normalizeNullableString(decision.missingInfo),
    handoffCategory: normalizeNullableString(decision.handoffCategory),
    attachment: normalizeAttachment(decision.attachment),
  };

  if (finalDecision.intent === "SALES_DM" && !finalDecision.privateContent) {
    logger.warn("ai.engine.sales_dm_missing_private_content", {
      reasoning: finalDecision.reasoning,
      publicContent: finalDecision.publicContent?.substring(0, 80),
    });
  }

  return finalDecision;
}

export function repairAndParseAiResponse(text: string): AiRoutingDecision {
  logger.debug("ai.engine.raw_response_trace", { text });
  const cleaned = extractJsonObjectCandidate(text);

  try {
    return normalizeParsedDecision(JSON.parse(cleaned));
  } catch (error: any) {
    logger.warn("ai.engine.structured_response_rejected", {
      error: error?.message || String(error),
      preview: cleaned.slice(0, 240),
    });
    throw error;
  }
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
  replyType?:
    | "NORMAL_REPLY"
    | "ASK_FOR_CORRECTION"
    | "CONFIRM_ACTION_SUCCESS"
    | "SAFE_ACTION_FAILURE"
    | "HANDOFF"
    | "RESOLVE";
  intent?: "SALES_DM" | "GREET_ONLY" | "IGNORE" | "NONE";
  handoffCategory?: string | null;
  reasoning: string;
  content?: string | null;
  publicContent?: string | null;
  privateContent?: string | null;
  requiresGrounding?: boolean;
  grounded?: boolean;
  usedChunkTypes?: string[];
  missingInfo?: string | null;
  attachment?: { assetName: string; caption?: string | null } | null;
  queuedActionRunId?: number;
  queuedActionSourceId?: number;
  agentTurnStatus?: "WAITING_ACTION" | "COMPLETED" | "FAILED";
}
