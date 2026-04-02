import prisma from "../../config/prisma";
import { logger } from "../../utils/logger";

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
): Promise<boolean> {
  // Fetch active CRM connections like HubSpot, GoHighLevel, or Webhooks
  const integrations = await prisma.crmIntegration.findMany({
    where: { businessProfileId, isActive: true },
  });

  if (integrations.length === 0) {
    logger.info("crm.no_active_integrations", { businessProfileId });
    return false;
  }

  let successCount = 0;

  for (const integration of integrations) {
    if (integration.provider === "webhook" && integration.webhookUrl) {
      try {
        // A generic POST allowing integrations via Zapier, Make.com, n8n, etc.
        const response = await fetch(integration.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...lead,
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
          logger.error("crm.webhook_validation_failed", {
            url: integration.webhookUrl,
            status: response.status,
            errorBody,
            leadPayload: lead
          });
        }
      } catch (err: any) {
        logger.error("crm.webhook_request_failed", { 
          url: integration.webhookUrl, 
          error: err.message 
        });
      }
    }
    
    // Future adapters (e.g. HubSpot) go here:
    // else if (integration.provider === "hubspot") { ... }
  }

  // Returns true if at least one CRM successfully received the lead
  return successCount > 0;
}
