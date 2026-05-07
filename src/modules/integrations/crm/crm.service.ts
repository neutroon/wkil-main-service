import prisma from "@config/prisma";
import { logger } from "@utils/logger";

export interface LeadPayload {
  [key: string]: any;
}

/**
 * Pushes a captured lead to all active CRM integrations for a given business profile.
 * Standardizes the AI's lead capture function so it scales easily across providers.
 */
export async function pushLeadToCrm(
  businessProfileId: number,
  lead: LeadPayload,
): Promise<{ success: boolean; error?: string }> {
  // Fetch active CRM connections like HubSpot, GoHighLevel, or Webhooks
  const integrations = await prisma.crmIntegration.findMany({
    where: { businessProfileId, isActive: true },
  });

  if (integrations.length === 0) {
    logger.info("crm.no_active_integrations", { businessProfileId });
    return { success: false, error: "No active integrations" };
  }

  let successCount = 0;
  let lastError = "Failed to push";

  for (const integration of integrations) {
    // ── Scalable Fixed Value Injection ────────────────────────────────
    // If a field is mapped to a static value (fixed: ...), we inject it here
    const fieldMapping = integration.fieldMapping as Record<string, any> | null;
    const finalLead = { ...lead };
    
    if (fieldMapping) {
      for (const [key, value] of Object.entries(fieldMapping)) {
        if (typeof value === "string" && value.startsWith("fixed:")) {
          finalLead[key] = value.replace("fixed:", "").trim();
        }
      }
    }

    if (integration.provider === "webhook" && integration.webhookUrl) {
      try {
        const response = await fetch(integration.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...finalLead,
            businessProfileId,
            timestamp: new Date().toISOString(),
          }),
        });

        if (response.ok) {
          logger.info("crm.webhook_success", { url: integration.webhookUrl, businessProfileId });
          successCount++;
        } else {
          // Parse the error body to capture specific validation errors (e.g. invalid mobile number)
          const errorBody = await response.text().catch(() => "Unable to read response body");
          lastError = errorBody;
          logger.error("crm.webhook_validation_failed", {
            url: integration.webhookUrl,
            status: response.status,
            errorBody,
            leadPayload: lead
          });
        }
      } catch (err: any) {
        lastError = String(err.message);
        logger.error("crm.webhook_request_failed", { 
          url: integration.webhookUrl, 
          error: err.message 
        });
      }
    }
  }

  return successCount > 0 ? { success: true } : { success: false, error: lastError };
}



