import {
  assertExternalArgsAllowedByPolicy,
  filterExternalArgsBySchema,
} from "@modules/integrations/external/agentActionExecutor.service";
import { findSemanticallyEligibleAgentActionSources } from "@modules/integrations/external/agentActionSemanticIndex.service";
import { logger } from "@utils/logger";
import type { BusinessProfileForChat } from "./businessChatReply.service";

type AgentActionSource = BusinessProfileForChat["agentActionSources"][number];
type ExternalActionValidationSource = {
  id: number;
  businessProfileId?: number | null;
  name?: string | null;
  description?: string | null;
  trigger?: string | null;
  actionType?: string | null;
  isActive?: boolean | null;
  expectedParamsSchema?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getFieldSource(value: unknown): string {
  if (!isRecord(value)) return "USER_PROVIDED";
  if (String(value.type ?? "").toUpperCase() === "FIXED") return "FIXED";
  return String(value.source ?? "USER_PROVIDED").toUpperCase();
}

function isAiWritableFieldRule(value: unknown): boolean {
  const source = getFieldSource(value);
  return source === "USER_PROVIDED" || source === "AI_DERIVED";
}

function collectRequiredAiWritableFields(
  schema: unknown,
  prefix = "",
): string[] {
  if (!isRecord(schema)) return [];

  const fields: string[] = [];
  for (const [key, rule] of Object.entries(schema)) {
    if (!isRecord(rule) || !isAiWritableFieldRule(rule)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (rule.required === true) {
      fields.push(path);
    }

    if (
      String(rule.type || "").toUpperCase() === "OBJECT" &&
      isRecord(rule.properties)
    ) {
      fields.push(...collectRequiredAiWritableFields(rule.properties, path));
    }
  }

  return fields;
}

function isMissingParamValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function normalizeActionRoutingText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670]/g, "")
    .replace(/[إأآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getByPath(source: unknown, path: string): unknown {
  if (!path) return source;
  return path.split(".").reduce<unknown>((current, part) => {
    if (!isRecord(current)) return undefined;
    return current[part];
  }, source);
}

const NON_ACTION_OPENING_PHRASES = new Set([
  "السلام عليكم",
  "السلام عليكم ورحمه الله وبركاته",
  "وعليكم السلام",
  "اهلا",
  "اهلا وسهلا",
  "اهلا بيكم",
  "مرحبا",
  "هلا",
  "هاي",
  "صباح الخير",
  "مساء الخير",
  "حد هنا",
  "في حد هنا",
  "هل يوجد احد",
  "hello",
  "hi",
  "hey",
  "good morning",
  "good evening",
]);

const NON_ACTION_OPENING_TOKENS = new Set([
  "السلام",
  "عليكم",
  "ورحمه",
  "الله",
  "وبركاته",
  "وعليكم",
  "اهلا",
  "وسهلا",
  "مرحبا",
  "هلا",
  "هاي",
  "صباح",
  "مساء",
  "الخير",
  "hello",
  "hi",
  "hey",
]);

function isClearlyNonActionOpening(message: string): boolean {
  const normalized = normalizeActionRoutingText(message);
  if (!normalized) return true;
  if (NON_ACTION_OPENING_PHRASES.has(normalized)) return true;

  const tokens = normalized.split(" ").filter(Boolean);
  return (
    tokens.length > 0 &&
    tokens.length <= 6 &&
    tokens.every((token) => NON_ACTION_OPENING_TOKENS.has(token))
  );
}

export async function validateChatRequestedExternalAction(params: {
  source: ExternalActionValidationSource;
  latestUserMessage: string;
  args?: Record<string, unknown>;
  historyText?: string;
  customerPhone?: string;
  conversationId?: number;
}): Promise<{ shouldQueue: boolean; reasoning: string }> {
  const source = params.source;
  const trigger = String(source.trigger ?? "CHAT_REQUESTED").toUpperCase();
  if (source.isActive === false) {
    return { shouldQueue: false, reasoning: "Source is inactive." };
  }
  if (trigger !== "CHAT_REQUESTED") {
    return { shouldQueue: false, reasoning: "Source is not chat-requested." };
  }
  if (!params.latestUserMessage.trim()) {
    return { shouldQueue: false, reasoning: "Latest customer message is empty." };
  }

  const filteredArgs = filterExternalArgsBySchema(
    source.expectedParamsSchema,
    params.args || {},
  );
  const missingRequired = collectRequiredAiWritableFields(
    source.expectedParamsSchema,
  ).filter((field) => isMissingParamValue(getByPath(filteredArgs, field)));

  if (missingRequired.length > 0) {
    return {
      shouldQueue: false,
      reasoning: `Missing required parameters: ${missingRequired.join(", ")}`,
    };
  }

  const policyCheck = assertExternalArgsAllowedByPolicy(
    source.expectedParamsSchema,
    filteredArgs,
    {
      latestUserText: params.latestUserMessage,
      historyText: params.historyText,
      customerPhone: params.customerPhone,
      conversationId: params.conversationId,
    },
  );
  if (!policyCheck.ok) {
    return {
      shouldQueue: false,
      reasoning: policyCheck.reason,
    };
  }

  return {
    shouldQueue: true,
    reasoning: "Deterministic action validation passed.",
  };
}

export async function filterEligibleAgentActionSources(
  sources: AgentActionSource[],
  latestUserMessage: string,
  options?: {
    businessProfileId?: number;
    queryEmbedding?: number[] | null;
    maxTools?: number;
    minSimilarity?: number;
  },
): Promise<AgentActionSource[]> {
  if (!latestUserMessage.trim()) return [];
  if (isClearlyNonActionOpening(latestUserMessage)) {
    logger.info("integration_action.semantic_router.skipped", {
      reason: "non_action_opening",
      businessProfileId: options?.businessProfileId,
    });
    return [];
  }
  if (!options?.businessProfileId || !options.queryEmbedding?.length) {
    logger.info("integration_action.semantic_router.skipped", {
      reason: "missing_query_embedding",
      businessProfileId: options?.businessProfileId,
    });
    return [];
  }

  return findSemanticallyEligibleAgentActionSources({
    businessProfileId: options.businessProfileId,
    sources,
    queryEmbedding: options.queryEmbedding,
    maxTools: options.maxTools,
    minSimilarity: options.minSimilarity,
  });
}
