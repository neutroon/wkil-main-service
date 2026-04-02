import prisma from "../../config/prisma";

export interface LeadPayload {
  name: string;
  email?: string;
  phone?: string;
  notes?: string;
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
    console.log(`[CRM] No active integrations found for profile ${businessProfileId}`);
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
          console.log(`[CRM] Successfully pushed lead to webhook: ${integration.webhookUrl}`);
          successCount++;
        } else {
          console.error(`[CRM] Webhook returned status ${response.status}`);
        }
      } catch (err: any) {
        console.error(`[CRM] Failed to push to webhook:`, err.message);
      }
    }
    
    // Future adapters (e.g. HubSpot) go here:
    // else if (integration.provider === "hubspot") { ... }
  }

  // Returns true if at least one CRM successfully received the lead
  return successCount > 0;
}
