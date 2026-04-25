import { z } from "zod";

/**
 * CRM Integration Schema
 * POST /v1/crm/business-profiles/:profileId
 */
export const crmIntegrationSchema = z.object({
  params: z.object({
    profileId: z.coerce.number(),
  }),
  body: z.object({
    provider: z.string().min(1, "Provider is required"),
    webhookUrl: z.string().url("Invalid webhook URL").optional().or(z.literal("")),
    apiKey: z.string().optional(),
    fieldMapping: z.record(z.string(), z.string()).optional(),
  }),
});

/**
 * Get CRM Integrations Schema
 * GET /v1/crm/business-profiles/:profileId
 */
export const getCrmSchema = z.object({
  params: z.object({
    profileId: z.coerce.number(),
  }),
});

/**
 * Delete CRM Integration Schema
 * DELETE /v1/crm/business-profiles/:profileId/:integrationId
 */
export const deleteCrmSchema = z.object({
  params: z.object({
    profileId: z.coerce.number(),
    integrationId: z.coerce.number(),
  }),
});
