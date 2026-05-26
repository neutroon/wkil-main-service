import { z } from "zod";
import { logger } from "@utils/logger";
import type { AgentToolDefinition } from "./agentState";

function getFieldSource(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "USER_PROVIDED";
  }
  const rule = value as Record<string, unknown>;
  if (String(rule.type ?? "").toUpperCase() === "FIXED") return "FIXED";
  return String(rule.source ?? "USER_PROVIDED").toUpperCase();
}

function isAiWritableFieldRule(value: unknown): boolean {
  const source = getFieldSource(value);
  return source === "USER_PROVIDED" || source === "AI_DERIVED";
}

function collectRequiredFields(
  mapping: Record<string, unknown> | null | undefined,
  defaultRequired: boolean,
): Set<string> {
  const required = new Set<string>();
  if (!mapping || typeof mapping !== "object") return required;

  for (const [key, value] of Object.entries(mapping)) {
    if (!isAiWritableFieldRule(value)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const requiredFlag = (value as any).required;
    if (requiredFlag === true || (requiredFlag !== false && defaultRequired)) {
      required.add(key);
    }
  }

  return required;
}

function hasRequiredAiWritableField(mapping: unknown): boolean {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    return false;
  }

  for (const value of Object.values(mapping as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (isAiWritableFieldRule(value) && (value as any).required === true) {
      return true;
    }

    const mappedType = String((value as any).type || "STRING").toUpperCase();
    if (mappedType === "OBJECT" && hasRequiredAiWritableField((value as any).properties)) {
      return true;
    }
    if (
      mappedType === "ARRAY" &&
      hasRequiredAiWritableField((value as any).items?.properties || (value as any).items)
    ) {
      return true;
    }
  }

  return false;
}

function describeSchema<T extends z.ZodTypeAny>(
  schema: T,
  description: string,
): T {
  return description ? (schema.describe(description) as T) : schema;
}

function buildZodField(key: string, value: any): z.ZodTypeAny {
  const mappedType = String(value?.type || "STRING").toUpperCase();
  const description = String(
    value?.description ||
      (mappedType === "OBJECT" ? `Details for ${key}` : `The ${key}`),
  );

  if (mappedType === "ARRAY") {
    const itemConfig = value?.items || {};
    const itemProperties =
      itemConfig && typeof itemConfig === "object" && !Array.isArray(itemConfig)
        ? (itemConfig as any).properties || itemConfig
        : {};
    const itemSchema = buildZodObject(itemProperties, false);
    return describeSchema(z.array(itemSchema), description);
  }

  if (mappedType === "OBJECT") {
    return describeSchema(buildZodObject(value?.properties || {}, false), description);
  }

  if (mappedType === "NUMBER") return describeSchema(z.number(), description);
  if (mappedType === "INTEGER") return describeSchema(z.number().int(), description);
  if (mappedType === "BOOLEAN") return describeSchema(z.boolean(), description);
  if (mappedType === "STRING") return describeSchema(z.string(), description);

  throw new Error(`Unsupported AI schema field type "${mappedType}" for "${key}"`);
}

function buildZodObject(
  mapping: Record<string, unknown> | null | undefined,
  defaultRequired: boolean,
): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const required = collectRequiredFields(mapping, defaultRequired);

  if (!mapping || typeof mapping !== "object") {
    return z.object({});
  }

  for (const [key, value] of Object.entries(mapping)) {
    if (!isAiWritableFieldRule(value)) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const fieldSchema = buildZodField(key, value);
    shape[key] = required.has(key) ? fieldSchema : fieldSchema.optional();
  }

  return z.object(shape);
}

export function buildAgentActionTools(dataSources: any[]): AgentToolDefinition[] {
  if (!dataSources || dataSources.length === 0) return [];

  return dataSources.flatMap((source) => {
    let schema: z.ZodObject<any>;
    try {
      schema = buildZodObject(source.expectedParamsSchema, false);
    } catch (error: any) {
      logger.warn("ai.external_tool.invalid_schema_skipped", {
        sourceId: source.id,
        sourceName: source.name,
        error: error?.message || String(error),
      });
      return [];
    }

    const hasDeclaredParams = Object.keys(schema.shape).length > 0;
    const actionType = String(source.actionType || "LOOKUP").toUpperCase();
    const isMutation = actionType === "MUTATION";
    if (!isMutation && !hasRequiredAiWritableField(source.expectedParamsSchema)) {
      logger.warn("ai.external_tool.unscoped_lookup_skipped", {
        sourceId: source.id,
        sourceName: source.name,
      });
      return [];
    }

    return [
      {
        name: `integration_action_${source.id}`,
        description: [
          isMutation
            ? `Chat-requested business action for "${source.name}". Calling this queues the action in the background.`
            : `Chat-requested information action for "${source.name}". Calling this queues the check in the background.`,
          source.description ||
            "Use only when this action directly matches the user's latest request.",
          "Decide from the current customer request and recent chat history, not the newest message in isolation.",
          "Do not call for greetings, generic support, customer detail saving, unrelated human handoff, or conversation closing.",
          "When required details are collected over several turns, combine the current message with recent history and do not ask again for details already present unless they are ambiguous or invalid.",
          "For booking, registration, follow-up contact, create, update, or cancel requests, ask for any missing target item/service/course/order or required contact detail before calling.",
          "Do not use this action merely to discover which item the customer wants unless the customer explicitly asked to see or check available options.",
          hasDeclaredParams
            ? "If required details are missing, ask the customer for them instead of inventing parameters."
            : "This action requires no customer-supplied parameters; call it with an empty argument object only when the user's request directly needs this action.",
          isMutation
            ? "Do not confirm completion from the queue result. Confirm only after a later verified action result is available."
            : "Do not answer the factual request from the queue result. Answer only after a later verified action result is available.",
        ].join(" "),
        schema,
      },
    ];
  });
}
