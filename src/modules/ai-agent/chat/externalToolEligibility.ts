import {
  assertExternalArgsAllowedByPolicy,
  filterExternalArgsBySchema,
} from "@modules/integrations/external/agentActionExecutor.service";

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

function hasRequiredAiWritableField(schema: unknown): boolean {
  return collectRequiredAiWritableFields(schema).length > 0;
}

function isMissingParamValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function getByPath(source: unknown, path: string): unknown {
  if (!path) return source;
  return path.split(".").reduce<unknown>((current, part) => {
    if (!isRecord(current)) return undefined;
    return current[part];
  }, source);
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
  if (
    String(source.actionType ?? "LOOKUP").toUpperCase() === "LOOKUP" &&
    !hasRequiredAiWritableField(source.expectedParamsSchema)
  ) {
    return {
      shouldQueue: false,
      reasoning:
        "Lookup action is not scoped. Add at least one required parameter before activating it.",
    };
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
