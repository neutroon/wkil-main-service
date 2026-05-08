import { z } from "zod";
import { assertExternalApiUrlLooksSafe } from "@modules/integrations/external/externalData.service";
import { aiSchemaObject } from "@modules/integrations/schemaRules.validation";

const safeWebhookUrl = z.string().url("Invalid webhook URL").superRefine((url, ctx) => {
  try {
    assertExternalApiUrlLooksSafe(url);
  } catch (error: any) {
    ctx.addIssue({
      code: "custom",
      message: error?.message || "Webhook URL is not allowed",
    });
  }
});

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
    webhookUrl: safeWebhookUrl.optional().or(z.literal("")),
    apiKey: z.string().optional(),
    fieldMapping: aiSchemaObject.optional(),
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
