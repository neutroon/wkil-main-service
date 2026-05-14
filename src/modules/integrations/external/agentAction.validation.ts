import { z } from "zod";
import { assertExternalApiUrlLooksSafe } from "./agentActionExecutor.service";
import { aiSchemaObject } from "@modules/integrations/schemaRules.validation";
import {
  EXTERNAL_FAILURE_BEHAVIORS,
  EXTERNAL_ROUTER_TIMEOUT,
  EXTERNAL_ROUTING_MODES,
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

const routingMode = z.enum(EXTERNAL_ROUTING_MODES);
const failureBehavior = z.enum(EXTERNAL_FAILURE_BEHAVIORS);
const actionType = z.enum(INTEGRATION_ACTION_TYPES);
const trigger = z.enum(INTEGRATION_ACTION_TRIGGERS);
const executionMode = z.enum(INTEGRATION_EXECUTION_MODES);
const confirmationPolicy = z.enum(INTEGRATION_CONFIRMATION_POLICIES);
const routerTimeoutMs = z.coerce
  .number()
  .int()
  .min(EXTERNAL_ROUTER_TIMEOUT.minMs, "Router timeout must be at least 1 second")
  .max(EXTERNAL_ROUTER_TIMEOUT.maxMs, "Router timeout must be 10 seconds or less");
const stringRecord = z.record(z.string(), z.string());
const nullableStringRecordAsEmpty = z.preprocess(
  (value) => (value === null ? {} : value),
  stringRecord.optional(),
);

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
    queryParams: nullableStringRecordAsEmpty,
    trigger: trigger.optional().default("CHAT_REQUESTED"),
    actionType: actionType.optional().default("LOOKUP"),
    executionMode: executionMode.optional().default("BACKGROUND"),
    routingMode: routingMode.optional().default("STRICT"),
    routerTimeoutMs: routerTimeoutMs.optional().default(EXTERNAL_ROUTER_TIMEOUT.defaultMs),
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
    queryParams: nullableStringRecordAsEmpty,
    trigger: trigger.optional(),
    actionType: actionType.optional(),
    executionMode: executionMode.optional(),
    routingMode: routingMode.optional(),
    routerTimeoutMs: routerTimeoutMs.optional(),
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
