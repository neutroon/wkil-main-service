import { z } from "zod";
import { assertExternalApiUrlLooksSafe } from "./externalData.service";
import { aiSchemaObject } from "@modules/integrations/schemaRules.validation";

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

const routingMode = z.enum(["STRICT", "FAST"]);
const failureBehavior = z.enum([
  "AUTO",
  "HANDOFF_ON_FAILURE",
  "ANSWER_WITH_CONTEXT_ON_FAILURE",
  "SILENT_ON_FAILURE",
]);
const routerTimeoutMs = z.coerce
  .number()
  .int()
  .min(1000, "Router timeout must be at least 1 second")
  .max(10000, "Router timeout must be 10 seconds or less");

/**
 * Data Source Schema
 * POST /v1/external-data-sources/business-profiles/:profileId
 */
export const dataSourceSchema = z.object({
  params: z.object({
    profileId: z.coerce.number(),
  }),
  body: z.object({
    name: z.string().min(1, "Name is required"),
    description: z.string().min(1, "Description is required"),
    apiUrl: safeExternalUrl,
    method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().default("GET"),
    headers: z.record(z.string(), z.string()).optional(),
    queryParams: z.record(z.string(), z.string()).optional(),
    routingMode: routingMode.optional().default("STRICT"),
    routerTimeoutMs: routerTimeoutMs.optional().default(2500),
    failureBehavior: failureBehavior.optional().default("AUTO"),
    expectedParamsSchema: aiSchemaObject.nullable().optional(),
    isActive: z.boolean().optional().default(true),
  }),
});

/**
 * Update Data Source Schema
 * PUT /v1/external-data-sources/business-profiles/:profileId/:sourceId
 */
export const updateDataSourceSchema = z.object({
  params: z.object({
    profileId: z.coerce.number(),
    sourceId: z.coerce.number(),
  }),
  body: z.object({
    name: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    apiUrl: safeExternalUrl.optional(),
    method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    queryParams: z.record(z.string(), z.string()).optional(),
    routingMode: routingMode.optional(),
    routerTimeoutMs: routerTimeoutMs.optional(),
    failureBehavior: failureBehavior.optional(),
    expectedParamsSchema: aiSchemaObject.nullable().optional(),
    isActive: z.boolean().optional(),
  }),
});

/**
 * Get Data Sources Schema
 */
export const getDataSourceSchema = z.object({
  params: z.object({
    profileId: z.coerce.number(),
  }),
});

/**
 * Delete Data Source Schema
 */
export const deleteDataSourceSchema = z.object({
  params: z.object({
    profileId: z.coerce.number(),
    sourceId: z.coerce.number(),
  }),
});
