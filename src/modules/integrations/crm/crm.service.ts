import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { assertExternalApiUrlNetworkSafe } from "@modules/integrations/external/externalData.service";
import {
  backoffDelayMs,
  classifyHttpRetry,
  classifyNetworkRetry,
  waitForRetry,
} from "@modules/integrations/retryPolicy";
import crypto from "crypto";

export interface LeadPayload {
  [key: string]: any;
}

const CRM_WEBHOOK_TIMEOUT_MS = 8_000;
const MAX_CRM_WEBHOOK_ATTEMPTS = 2;
const MAX_CRM_ERROR_BODY_BYTES = 4_000;
const DEFAULT_LEAD_KEY = "unknown_lead";

type CrmDeliveryOutcome = {
  integrationId: number;
  status: "delivered" | "updated" | "skipped_duplicate" | "failed";
  eventType: "lead_created" | "lead_updated";
};

function buildWebhookHeaders(apiKey?: string | null): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${decryptFacebookSecret(apiKey)}`;
  }
  return headers;
}

async function readLimitedText(response: Response): Promise<string> {
  const text = await response.text().catch(() => "Unable to read response body");
  return Buffer.byteLength(text, "utf8") > MAX_CRM_ERROR_BODY_BYTES
    ? text.slice(0, MAX_CRM_ERROR_BODY_BYTES) + "...[truncated]"
    : text;
}

async function postWebhookOnce(
  webhookUrl: string,
  headers: Record<string, string>,
  body: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CRM_WEBHOOK_TIMEOUT_MS);
  try {
    return await fetch(webhookUrl, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers,
      body,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function postWebhookWithRetry(
  webhookUrl: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ response: Response; attempts: number }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_CRM_WEBHOOK_ATTEMPTS; attempt++) {
    try {
      const response = await postWebhookOnce(webhookUrl, headers, body);
      const retryDecision = classifyHttpRetry(response.status);
      if (!response.ok && retryDecision.retryable && attempt < MAX_CRM_WEBHOOK_ATTEMPTS) {
        logger.warn("crm.webhook_retrying_http", {
          host: new URL(webhookUrl).host,
          status: response.status,
          attempt,
        });
        await waitForRetry(backoffDelayMs(attempt));
        continue;
      }
      return { response, attempts: attempt };
    } catch (error) {
      lastError = error;
      const retryDecision = classifyNetworkRetry(error);
      if (retryDecision.retryable && attempt < MAX_CRM_WEBHOOK_ATTEMPTS) {
        logger.warn("crm.webhook_retrying_network", {
          host: new URL(webhookUrl).host,
          reason: retryDecision.reason,
          attempt,
        });
        await waitForRetry(backoffDelayMs(attempt));
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function cleanLeadValue(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  if (Array.isArray(value)) {
    const items = value
      .map(cleanLeadValue)
      .filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (value && typeof value === "object") {
    const cleaned = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, cleanLeadValue(item)] as const)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return cleaned.length > 0 ? Object.fromEntries(cleaned) : undefined;
  }
  return value ?? undefined;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(cleanLeadValue(value) ?? {});
}

function hashPayload(payload: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function normalizeIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function normalizePhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/[^\d+]/g, "");
  return digits || null;
}

function buildLeadKey(lead: LeadPayload): string {
  if (lead.conversationId) return `conversation:${lead.conversationId}`;
  const phone = normalizePhone(lead.phone);
  if (phone) return `phone:${phone}`;
  const email = normalizeIdentity(lead.email);
  if (email) return `email:${email}`;
  const name = normalizeIdentity(lead.name);
  if (name) return `name:${name}`;
  return DEFAULT_LEAD_KEY;
}

function publicLeadPayload(finalLead: LeadPayload): Record<string, unknown> {
  const { idempotencyKey, conversationId, customerId, ...payload } = finalLead;
  return cleanLeadValue(payload) as Record<string, unknown>;
}

function resolveFieldSource(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "USER_PROVIDED";
  }
  const rule = value as Record<string, unknown>;
  if (String(rule.type ?? "").toUpperCase() === "FIXED") return "FIXED";
  return String(rule.source ?? "USER_PROVIDED").toUpperCase();
}

function isMissingLeadValue(value: unknown): boolean {
  return cleanLeadValue(value) === undefined;
}

function resolveSystemFieldValue(value: unknown, finalLead: LeadPayload): {
  source: string;
  value: unknown;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { source: "USER_PROVIDED", value: undefined };
  }
  const rule = value as Record<string, unknown>;
  const source = resolveFieldSource(rule);

  if (source === "FIXED" || source === "DEFAULT") {
    return { source, value: rule.value };
  }

  if (source === "CHAT_CONTEXT") {
    if (rule.contextKey === "customerPhone") return { source, value: finalLead.phone };
    if (rule.contextKey === "conversationId") {
      return { source, value: finalLead.conversationId };
    }
  }

  return { source, value: undefined };
}

/**
 * Pushes a captured lead to all active CRM integrations for a given business profile.
 * Pushes locally saved customer details to active downstream CRM/webhook providers.
 */
export async function syncCustomerDetailsToCrm(
  businessProfileId: number,
  lead: LeadPayload,
): Promise<{ success: boolean; error?: string; deliveries?: CrmDeliveryOutcome[] }> {
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
  const deliveries: CrmDeliveryOutcome[] = [];

  for (const integration of integrations) {
    // ── Scalable Server-Owned Value Injection ─────────────────────────
    // FIXED always wins. DEFAULT fills only when no higher-priority value exists.
    const fieldMapping = integration.fieldMapping as Record<string, any> | null;
    const finalLead = { ...lead };
    
    if (fieldMapping) {
      for (const [key, value] of Object.entries(fieldMapping)) {
        const resolved = resolveSystemFieldValue(value, finalLead);
        if (resolved.source === "FIXED" && resolved.value !== undefined) {
          finalLead[key] = resolved.value;
        }
        if (
          resolved.source === "DEFAULT" &&
          resolved.value !== undefined &&
          isMissingLeadValue(finalLead[key])
        ) {
          finalLead[key] = resolved.value;
        }
        if (
          resolved.source === "CHAT_CONTEXT" &&
          resolved.value !== undefined &&
          resolved.value !== null &&
          resolved.value !== ""
        ) {
          finalLead[key] = resolved.value;
        }
      }
    }

    if (integration.provider === "webhook" && integration.webhookUrl) {
      const payload = publicLeadPayload(finalLead);
      const payloadHash = hashPayload(payload);
      const leadKey = buildLeadKey(finalLead);
      const customerId =
        typeof finalLead.customerId === "number" ? finalLead.customerId : undefined;
      const idempotencyKey =
        typeof finalLead.idempotencyKey === "string" && finalLead.idempotencyKey
          ? finalLead.idempotencyKey
          : `${leadKey}:${payloadHash}`;

      const samePayloadDelivered = await prisma.crmDeliveryLog.findFirst({
        where: {
          businessProfileId,
          integrationId: integration.id,
          leadKey,
          payloadHash,
          status: "DELIVERED",
        },
      });

      if (samePayloadDelivered) {
        await prisma.crmDeliveryLog.create({
          data: {
            businessProfileId,
            integrationId: integration.id,
            customerId,
            idempotencyKey,
            leadKey,
            payloadHash,
            eventType: samePayloadDelivered.eventType,
            status: "SKIPPED_DUPLICATE",
            deliveredAt: new Date(),
          },
        }).catch(() => undefined);
        deliveries.push({
          integrationId: integration.id,
          status: "skipped_duplicate",
          eventType: samePayloadDelivered.eventType as "lead_created" | "lead_updated",
        });
        successCount++;
        continue;
      }

      const previousLeadDelivery = await prisma.crmDeliveryLog.findFirst({
        where: {
          businessProfileId,
          integrationId: integration.id,
          leadKey,
          status: "DELIVERED",
        },
        orderBy: { deliveredAt: "desc" },
      });
      const eventType = previousLeadDelivery ? "lead_updated" : "lead_created";

      let deliveryLog = await prisma.crmDeliveryLog.findFirst({
        where: { businessProfileId, integrationId: integration.id, idempotencyKey },
      });

      if (deliveryLog?.status === "DELIVERED") {
        deliveries.push({
          integrationId: integration.id,
          status: "skipped_duplicate",
          eventType: deliveryLog.eventType as "lead_created" | "lead_updated",
        });
        successCount++;
        continue;
      }

      if (!deliveryLog) {
        deliveryLog = await prisma.crmDeliveryLog.create({
          data: {
            businessProfileId,
            integrationId: integration.id,
            customerId,
            idempotencyKey,
            leadKey,
            payloadHash,
            eventType,
            status: "PENDING",
          },
        });
      }

      try {
        await assertExternalApiUrlNetworkSafe(integration.webhookUrl);
        const webhookBody = JSON.stringify({
            ...payload,
            businessProfileId,
            eventType,
            leadKey,
            idempotencyKey,
            timestamp: new Date().toISOString(),
          });
        const { response, attempts } = await postWebhookWithRetry(
          integration.webhookUrl,
          buildWebhookHeaders(integration.apiKey),
          webhookBody,
        );

        if (response.ok) {
          logger.info("crm.webhook_success", {
            host: new URL(integration.webhookUrl).host,
            businessProfileId,
            eventType,
            attempts,
          });
          await prisma.crmDeliveryLog.update({
            where: { id: deliveryLog.id },
            data: {
              status: "DELIVERED",
              attempts: { increment: attempts },
              lastError: null,
              deliveredAt: new Date(),
            },
          });
          deliveries.push({
            integrationId: integration.id,
            status: eventType === "lead_updated" ? "updated" : "delivered",
            eventType,
          });
          successCount++;
        } else {
          // Parse the error body to capture specific validation errors (e.g. invalid mobile number)
          const errorBody = await readLimitedText(response);
          lastError = errorBody;
          const retryDecision = classifyHttpRetry(response.status);
          logger.error("crm.webhook_validation_failed", {
            host: new URL(integration.webhookUrl).host,
            status: response.status,
            errorBody,
            businessProfileId,
            attempts,
            retryable: retryDecision.retryable,
          });
          await prisma.crmDeliveryLog.update({
            where: { id: deliveryLog.id },
            data: {
              status: "FAILED",
              attempts: { increment: attempts },
              lastError: errorBody,
            },
          });
          deliveries.push({
            integrationId: integration.id,
            status: "failed",
            eventType,
          });
        }
      } catch (err: any) {
        lastError = String(err.message);
        logger.error("crm.webhook_request_failed", { 
          host: new URL(integration.webhookUrl).host,
          businessProfileId,
          error: err.message 
        });
        await prisma.crmDeliveryLog.update({
          where: { id: deliveryLog.id },
          data: {
            status: "FAILED",
            attempts: { increment: 1 },
            lastError,
          },
        });
        deliveries.push({
          integrationId: integration.id,
          status: "failed",
          eventType,
        });
      }
    }
  }

  return successCount > 0
    ? { success: true, deliveries }
    : { success: false, error: lastError, deliveries };
}



