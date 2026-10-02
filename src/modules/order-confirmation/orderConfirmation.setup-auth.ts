import type { Request } from "express";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { verifyOrderWebhookSignature } from "./orderConfirmation.crypto";
import { findOrderIntegrationForSetup } from "./orderConfirmation.repository";
import type { IntegrationFailure, OrderTemplateContext } from "./orderConfirmation.integration.types";

export class OrderSetupHttpError extends Error {
  constructor(readonly status: number, readonly failure: IntegrationFailure) { super(failure.message); }
}
export function setupError(status: number, code: string, message: string, retryable = false): OrderSetupHttpError {
  return new OrderSetupHttpError(status, { code, message, retryable, errors: [] });
}
export async function authenticateOrderSetupRequest(req: Request): Promise<OrderTemplateContext> {
  if (!Buffer.isBuffer(req.body) || req.body.length > 256 * 1024) throw setupError(400, "INVALID_REQUEST", "A bounded raw JSON body is required");
  const key = req.params.integrationKey;
  if (typeof key !== "string") throw setupError(404, "INTEGRATION_NOT_FOUND", "Integration not found");
  const integration = await findOrderIntegrationForSetup(key);
  if (!integration) throw setupError(404, "INTEGRATION_NOT_FOUND", "Integration not found");
  const timestamp = req.headers["x-wkil-timestamp"], signature = req.headers["x-wkil-signature"];
  const secrets = [integration.signingSecret, integration.previousSigningSecret].filter((secret): secret is string => !!secret);
  const valid = secrets.some(encrypted => {
    const secret = decryptFacebookSecret(encrypted);
    return !!secret && verifyOrderWebhookSignature({ rawBody: req.body, secret, timestamp: typeof timestamp === "string" ? timestamp : undefined, signature: typeof signature === "string" ? signature : undefined });
  });
  if (!valid) throw setupError(401, "INVALID_SIGNATURE", "Invalid or expired signature");
  return { integrationId: integration.id, businessProfileId: integration.businessProfileId, whatsappAccountId: integration.whatsappAccountId, defaultLocale: integration.defaultLocale === "ar" ? "ar" : "en" };
}
