import {
  assertExternalArgsAllowedByPolicy,
  filterExternalArgsBySchema,
} from "@modules/integrations/external/externalData.service";
import { findSemanticallyEligibleExternalDataSources } from "@modules/integrations/external/externalActionSemanticIndex.service";
import { logger } from "@utils/logger";
import type { BusinessProfileForChat } from "./businessChatReply.service";

type ExternalDataSource = BusinessProfileForChat["externalDataSources"][number];
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

function collectRequiredAiWritableFields(schema: unknown): string[] {
  if (!isRecord(schema)) return [];

  return Object.entries(schema)
    .filter(([, rule]) => {
      if (!isRecord(rule) || !isAiWritableFieldRule(rule)) return false;
      return rule.required === true;
    })
    .map(([key]) => key);
}

function isMissingParamValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
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
  ).filter((field) => isMissingParamValue(filteredArgs[field]));

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

export async function filterEligibleExternalDataSources(
  sources: ExternalDataSource[],
  latestUserMessage: string,
  options?: {
    businessProfileId?: number;
    queryEmbedding?: number[] | null;
    maxTools?: number;
    minSimilarity?: number;
  },
): Promise<ExternalDataSource[]> {
  if (!latestUserMessage.trim()) return [];
  if (!options?.businessProfileId || !options.queryEmbedding?.length) {
    logger.info("integration_action.semantic_router.skipped", {
      reason: "missing_query_embedding",
      businessProfileId: options?.businessProfileId,
    });
    return [];
  }

  return findSemanticallyEligibleExternalDataSources({
    businessProfileId: options.businessProfileId,
    sources,
    queryEmbedding: options.queryEmbedding,
    maxTools: options.maxTools,
    minSimilarity: options.minSimilarity,
  });
}
