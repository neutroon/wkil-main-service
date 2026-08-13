import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { logger } from "@utils/logger";
import { enqueueOrderEvent } from "./orderConfirmation.queue";
import { verifyOrderWebhookSignature } from "./orderConfirmation.crypto";
import { parseCanonicalOrderEvent } from "./orderConfirmation.validation";
import {
  findActiveIntegrationByPublicKey,
  insertOrderEventIfNew,
} from "./orderConfirmation.repository";

function sendBadRequest(res: Response, message: string): void {
  res.status(400).json({ error: message });
}

function sendAccepted(res: Response, eventId: string, duplicate: boolean): void {
  res.status(202).json({ accepted: true, duplicate, eventId });
}

export async function receiveOrderEvent(req: Request, res: Response): Promise<void> {
  const correlationId = randomUUID();
  const rawBody = req.body;

  if (!Buffer.isBuffer(rawBody)) {
    sendBadRequest(res, "Request body must be raw JSON");
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    sendBadRequest(res, "Malformed JSON body");
    return;
  }

  const bodyEventId =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as { eventId?: unknown }).eventId
      : undefined;
  const idempotencyKey = req.headers["idempotency-key"];

  if (
    typeof bodyEventId !== "string" ||
    bodyEventId.length === 0 ||
    typeof idempotencyKey !== "string" ||
    idempotencyKey !== bodyEventId
  ) {
    sendBadRequest(res, "Idempotency-Key must match eventId");
    return;
  }

  let integration: Awaited<ReturnType<typeof findActiveIntegrationByPublicKey>>;
  try {
    integration = await findActiveIntegrationByPublicKey(req.params.integrationKey);
  } catch {
    logger.error("order_confirmation.webhook.integration_lookup_failed", {
      correlationId,
      eventId: bodyEventId,
    });
    res.status(500).json({ error: "Unable to accept event" });
    return;
  }

  if (!integration || !integration.isActive) {
    res.status(404).json({ error: "Integration not found" });
    return;
  }

  let signingSecret: string;
  try {
    signingSecret = decryptFacebookSecret(integration.signingSecret);
    if (typeof signingSecret !== "string" || signingSecret.length === 0) {
      throw new Error("Missing signing secret");
    }
  } catch {
    logger.error("order_confirmation.webhook.secret_unavailable", {
      correlationId,
      eventId: bodyEventId,
      integrationId: integration.id,
    });
    res.status(500).json({ error: "Unable to accept event" });
    return;
  }

  const timestamp = req.headers["x-wkil-timestamp"];
  const signature = req.headers["x-wkil-signature"];
  if (
    !verifyOrderWebhookSignature({
      rawBody,
      timestamp: typeof timestamp === "string" ? timestamp : undefined,
      signature: typeof signature === "string" ? signature : undefined,
      secret: signingSecret,
    })
  ) {
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  let event: ReturnType<typeof parseCanonicalOrderEvent>;
  try {
    event = parseCanonicalOrderEvent(body);
  } catch {
    sendBadRequest(res, "Malformed order event");
    return;
  }

  let result: Awaited<ReturnType<typeof insertOrderEventIfNew>>;
  try {
    result = await insertOrderEventIfNew({
      integrationId: integration.id,
      businessProfileId: integration.businessProfileId,
      externalEventId: event.eventId,
      eventType: event.eventType,
      schemaVersion: event.schemaVersion,
      occurredAt: new Date(event.occurredAt),
      rawPayload: event,
    });
  } catch {
    logger.error("order_confirmation.webhook.persistence_failed", {
      correlationId,
      eventId: event.eventId,
    });
    res.status(500).json({ error: "Unable to accept event" });
    return;
  }

  if (result.duplicate) {
    sendAccepted(res, event.eventId, true);
    return;
  }

  try {
    await enqueueOrderEvent(result.event.id, correlationId);
  } catch {
    logger.error("order_confirmation.webhook.enqueue_failed", {
      correlationId,
      eventId: event.eventId,
      orderEventId: result.event.id,
    });
  }

  sendAccepted(res, event.eventId, false);
}
