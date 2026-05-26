import { z } from "zod";
import { assertExternalApiUrlLooksSafe } from "./agentActionExecutor.service";
import { aiSchemaObject } from "@modules/integrations/schemaRules.validation";
import {
  EXTERNAL_FAILURE_BEHAVIORS,
  INTEGRATION_ACTION_TYPES,
  INTEGRATION_ACTION_TRIGGERS,
  INTEGRATION_CONFIRMATION_POLICIES,
  INTEGRATION_EXECUTION_MODES,
} from "./agentActionSource.constants";

const safeExternalUrl = z.string().url("Invalid API URL").superRefine((url, ctx) => {
  try {
    assertExternalApiUrlLooksSafe(url);
  } catch (error: any) {
    ctx.addIssue({
      code: "custom",
      message: error?.message || "External API URL is not allowed",
    });
  }
});

const failureBehavior = z.enum(EXTERNAL_FAILURE_BEHAVIORS);
const actionType = z.enum(INTEGRATION_ACTION_TYPES);
const trigger = z.enum(INTEGRATION_ACTION_TRIGGERS);
const executionMode = z.enum(INTEGRATION_EXECUTION_MODES);
const confirmationPolicy = z.enum(INTEGRATION_CONFIRMATION_POLICIES);
const stringRecord = z.record(z.string(), z.string());
const nullableStringRecordAsEmpty = z.preprocess(
  (value) => (value === null ? {} : value),
  stringRecord.optional(),
);

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

export function hasRequiredAiWritableParam(schema: unknown): boolean {
  if (!isRecord(schema)) return false;

  for (const rule of Object.values(schema)) {
    if (!isRecord(rule)) continue;
    if (isAiWritableFieldRule(rule) && rule.required === true) return true;
    if (
      String(rule.type || "").toUpperCase() === "OBJECT" &&
      hasRequiredAiWritableParam(rule.properties)
    ) {
      return true;
    }
    if (
      String(rule.type || "").toUpperCase() === "ARRAY" &&
      isRecord(rule.items) &&
      hasRequiredAiWritableParam(rule.items.properties ?? rule.items)
    ) {
      return true;
    }
  }

  return false;
}

export function validateAgentActionActivationConfig(source: {
  actionType?: unknown;
  trigger?: unknown;
  isActive?: unknown;
  expectedParamsSchema?: unknown;
}): string | null {
  const actionType = String(source.actionType ?? "LOOKUP").toUpperCase();
  const trigger = String(source.trigger ?? "CHAT_REQUESTED").toUpperCase();
  const isActive = source.isActive !== false;

  if (
    isActive &&
    trigger === "CHAT_REQUESTED" &&
    actionType === "LOOKUP" &&
    !hasRequiredAiWritableParam(source.expectedParamsSchema)
  ) {
    return "Active lookup actions must define at least one required customer-provided or AI-derived parameter so the HTTP request can be scoped to the customer request.";
  }

  return null;
}

/**
 * Agent Action source schema
 * POST /v1/agent-actions/business-profiles/:profileId
 */
export const agentActionSourceSchema = z.object({
  params: z.object({
    profileId: z.coerce.number(),
  }),
  body: z.object({
    name: z.string().min(1, "Name is required"),
    description: z.string().min(1, "Description is required"),
    apiUrl: safeExternalUrl,
    method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().default("GET"),
    headers: nullableStringRecordAsEmpty,
    trigger: trigger.optional().default("CHAT_REQUESTED"),
    actionType: actionType.optional().default("LOOKUP"),
    executionMode: executionMode.optional().default("BACKGROUND"),
    failureBehavior: failureBehavior.optional().default("AUTO"),
    confirmationPolicy: confirmationPolicy.optional().default("REQUIRE_VERIFIED_RESULT"),
    requestMapping: z.record(z.string(), z.unknown()).nullable().optional(),
    responseMapping: z.record(z.string(), z.unknown()).nullable().optional(),
    expectedParamsSchema: aiSchemaObject.nullable().optional(),
    isActive: z.boolean().optional().default(true),
  }),
});

/**
 * Update Agent Action source schema
 * PUT /v1/agent-actions/business-profiles/:profileId/:sourceId
 */
export const updateAgentActionSourceSchema = z.object({
  params: z.object({
    profileId: z.coerce.number(),
    sourceId: z.coerce.number(),
  }),
  body: z.object({
    name: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    apiUrl: safeExternalUrl.optional(),
    method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional(),
    headers: nullableStringRecordAsEmpty,
    trigger: trigger.optional(),
    actionType: actionType.optional(),
    executionMode: executionMode.optional(),
    failureBehavior: failureBehavior.optional(),
    confirmationPolicy: confirmationPolicy.optional(),
    requestMapping: z.record(z.string(), z.unknown()).nullable().optional(),
    responseMapping: z.record(z.string(), z.unknown()).nullable().optional(),
    expectedParamsSchema: aiSchemaObject.nullable().optional(),
    isActive: z.boolean().optional(),
  }),
});

/**
 * Get Agent Action source schema
 */
export const getAgentActionSourceSchema = z.object({
  params: z.object({
    profileId: z.coerce.number(),
  }),
});

/**
 * Delete Agent Action source schema
 */
export const deleteAgentActionSourceSchema = z.object({
  params: z.object({
    profileId: z.coerce.number(),
    sourceId: z.coerce.number(),
  }),
});

export const testAgentActionSourceSchema = z.object({
  params: z.object({
    profileId: z.coerce.number(),
    sourceId: z.coerce.number(),
  }),
  body: z.object({
    args: z.record(z.string(), z.unknown()).optional().default({}),
    customerPhone: z.string().optional(),
    conversationId: z.coerce.number().optional(),
    contextValues: z.record(z.string(), z.unknown()).optional().default({}),
    latestUserText: z.string().optional(),
    historyText: z.string().optional(),
    run: z.boolean().optional().default(false),
  }),
});

export const testAgentActionWorkflowSchema = z.object({
  params: z.object({
    profileId: z.coerce.number(),
    workflowId: z.coerce.number(),
  }),
  body: z.object({
    lookupArgs: z.record(z.string(), z.unknown()).optional().default({}),
    mutationArgs: z.record(z.string(), z.unknown()).optional().default({}),
    customerPhone: z.string().optional(),
    conversationId: z.coerce.number().optional(),
    contextValues: z.record(z.string(), z.unknown()).optional().default({}),
    latestUserText: z.string().optional(),
    historyText: z.string().optional(),
    run: z.boolean().optional().default(false),
  }),
});

const inputBindingSource = z.enum([
  "USER_PROVIDED",
  "CHAT_CONTEXT",
  "ACTION_RESULT",
  "FIXED",
  "DEFAULT",
]);

const workflowFields = z.object({
  name: z.string().min(1, "Workflow name is required"),
  description: z.string().optional().nullable(),
  lookupSourceId: z.coerce.number().int().positive().nullable().optional(),
  mutationSourceId: z.coerce.number().int().positive().nullable().optional(),
  inputBindings: z.record(
    z.string(),
    z.object({
      source: inputBindingSource,
      path: z.string().optional(),
      value: z.unknown().optional(),
      default: z.unknown().optional(),
    }),
  ).nullable().optional(),
  isActive: z.boolean().optional().default(true),
});

const workflowBody = workflowFields.refine(
  (body) => Boolean(body.lookupSourceId || body.mutationSourceId),
  "Workflow must include at least one action step",
);

export const workflowSchema = z.object({
  params: z.object({
    profileId: z.coerce.number(),
  }),
  body: workflowBody,
});

export const updateWorkflowSchema = z.object({
  params: z.object({
    profileId: z.coerce.number(),
    workflowId: z.coerce.number(),
  }),
  body: workflowFields.partial().refine(
    (body) =>
      Object.keys(body).length > 0 &&
      (body.lookupSourceId !== undefined ||
        body.mutationSourceId !== undefined ||
        body.name !== undefined ||
        body.description !== undefined ||
        body.inputBindings !== undefined ||
        body.isActive !== undefined),
    "No workflow changes provided",
  ),
});

export const workflowIdSchema = z.object({
  params: z.object({
    profileId: z.coerce.number(),
    workflowId: z.coerce.number(),
  }),
});
