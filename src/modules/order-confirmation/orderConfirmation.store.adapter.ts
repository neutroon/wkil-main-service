import prisma from "@config/prisma";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { assertExternalApiUrlNetworkSafe } from "@modules/integrations/external/agentActionExecutor.service";
import {
  backoffDelayMs,
  classifyHttpRetry,
  classifyNetworkRetry,
} from "@modules/integrations/retryPolicy";
import { logger } from "@utils/logger";
import { computeOrderWebhookSignature } from "./orderConfirmation.crypto";

const CALLBACK_TIMEOUT_MS = 8_000;
const CALLBACK_EVENT_TYPE = "order.status_changed";

type StoreSyncRecord = NonNullable<
  Awaited<ReturnType<typeof findStoreSync>>
>;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function findStoreSync(syncId: number) {
  return prisma.orderStoreSync.findUnique({
    where: { id: syncId },
    select: {
      id: true,
      status: true,
      requestedStatus: true,
      providerIdempotencyKey: true,
      attemptCount: true,
      order: {
        select: {
          id: true,
          externalOrderId: true,
          events: {
            orderBy: { occurredAt: "desc" },
            take: 1,
            select: { externalEventId: true },
          },
          integration: {
            select: {
              id: true,
              isActive: true,
              storeSyncEnabled: true,
              statusCallbackUrl: true,
              statusCallbackSecret: true,
              previousStatusCallbackSecret: true,
            },
          },
        },
      },
    },
  });
}

async function markAttemptStarted(sync: StoreSyncRecord): Promise<number> {
  const attempt = (sync.attemptCount ?? 0) + 1;
  await prisma.orderStoreSync.update({
    where: { id: sync.id },
    data: {
      status: "PENDING",
      attemptCount: { increment: 1 },
      startedAt: new Date(),
      completedAt: null,
      failedAt: null,
      lastError: null,
      nextAttemptAt: null,
    },
  });
  return attempt;
}

async function markSucceeded(syncId: number, providerStatus: string): Promise<void> {
  await prisma.orderStoreSync.update({
    where: { id: syncId },
    data: {
      status: "SUCCEEDED",
      providerStatus,
      lastError: null,
      nextAttemptAt: null,
      completedAt: new Date(),
      failedAt: null,
    },
  });
}

async function markFailed(
  syncId: number,
  message: string,
  providerStatus?: string,
): Promise<void> {
  await prisma.orderStoreSync.update({
    where: { id: syncId },
    data: {
      status: "FAILED",
      ...(providerStatus ? { providerStatus } : {}),
      lastError: message,
      nextAttemptAt: null,
      failedAt: new Date(),
    },
  });
}

async function markPending(
  syncId: number,
  attempt: number,
  message: string,
  providerStatus?: string,
): Promise<void> {
  await prisma.orderStoreSync.update({
    where: { id: syncId },
    data: {
      status: "PENDING",
      ...(providerStatus ? { providerStatus } : {}),
      lastError: message,
      nextAttemptAt: new Date(Date.now() + backoffDelayMs(attempt)),
      failedAt: null,
    },
  });
}

function parseHttpsCallbackUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    throw new Error("Missing status callback URL");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid status callback URL");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error("Status callback URL must be an HTTPS URL without credentials or fragments");
  }

  return parsed.toString();
}

function callbackBody(sync: StoreSyncRecord): string {
  const eventId = sync.order.events?.[0]?.externalEventId ?? sync.providerIdempotencyKey;
  return JSON.stringify({
    eventType: CALLBACK_EVENT_TYPE,
    orderId: sync.order.id,
    externalOrderId: sync.order.externalOrderId,
    status: sync.requestedStatus,
    eventId,
    idempotencyKey: sync.providerIdempotencyKey,
  });
}

async function postCallback(
  url: string,
  body: string,
  idempotencyKey: string,
  timestamp: string,
  secret: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "X-Wkil-Timestamp": timestamp,
        "X-Wkil-Signature": computeOrderWebhookSignature(
          timestamp,
          Buffer.from(body, "utf8"),
          secret,
        ),
      },
      body,
      redirect: "manual",
      signal: controller.signal,
    });

    if (response.body) {
      try {
        await response.body.cancel();
      } catch (error) {
        logger.warn("order_confirmation.store_sync_response_body_cancel_failed", {
          error: errorMessage(error),
        });
      }
    }

    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

function isSuccessResponse(response: Response): boolean {
  return (response.status >= 200 && response.status < 300) || response.status === 409;
}

async function recordDeliveryFailure(
  sync: StoreSyncRecord,
  attempt: number,
  response: Response,
): Promise<void> {
  const status = String(response.status);
  const message = `Store status callback returned HTTP ${response.status}`;
  const retryDecision = classifyHttpRetry(response.status);

  if (retryDecision.retryable) {
    await markPending(sync.id, attempt, message, status);
    logger.warn("order_confirmation.store_sync_retryable_failure", {
      syncId: sync.id,
      status: response.status,
      reason: retryDecision.reason,
    });
    throw new Error(message);
  }

  await markFailed(sync.id, message, status);
  logger.error("order_confirmation.store_sync_failed", {
    syncId: sync.id,
    status: response.status,
    reason: retryDecision.reason,
  });
}

async function recordNetworkFailure(
  sync: StoreSyncRecord,
  attempt: number,
  error: unknown,
): Promise<void> {
  const retryDecision = classifyNetworkRetry(error);
  const message = "Store status callback network request failed";

  if (retryDecision.retryable) {
    await markPending(sync.id, attempt, message);
    logger.warn("order_confirmation.store_sync_network_retry", {
      syncId: sync.id,
      reason: retryDecision.reason,
    });
    throw new Error(message);
  }

  await markFailed(sync.id, message);
  logger.error("order_confirmation.store_sync_network_failed", {
    syncId: sync.id,
    reason: retryDecision.reason,
    error: errorMessage(error),
  });
}

export async function sendGenericOrderStatusCallback(syncId: number): Promise<void> {
  const sync = await findStoreSync(syncId);
  if (!sync) {
    throw new Error("Order store sync not found");
  }
  if (sync.status === "SUCCEEDED" || sync.status === "DISABLED") {
    return;
  }

  const attempt = await markAttemptStarted(sync);
  const integration = sync.order?.integration;
  if (!integration || !integration.isActive || !integration.storeSyncEnabled) {
    await markFailed(sync.id, "Store synchronization is not active");
    return;
  }

  let callbackUrl: string;
  let currentSecret: string;
  try {
    callbackUrl = parseHttpsCallbackUrl(integration.statusCallbackUrl);
    if (typeof integration.statusCallbackSecret !== "string" || integration.statusCallbackSecret.length === 0) {
      throw new Error("Missing status callback secret");
    }
    currentSecret = decryptFacebookSecret(integration.statusCallbackSecret);
    if (currentSecret.length === 0) {
      throw new Error("Missing status callback secret");
    }
  } catch (error) {
    await recordNetworkFailure(sync, attempt, error);
    return;
  }

  const body = callbackBody(sync);
  const timestamp = String(Math.floor(Date.now() / 1000));
  let response: Response;
  try {
    await assertExternalApiUrlNetworkSafe(callbackUrl);
    response = await postCallback(
      callbackUrl,
      body,
      sync.providerIdempotencyKey,
      timestamp,
      currentSecret,
    );

    if ((response.status === 401 || response.status === 403) && integration.previousStatusCallbackSecret) {
      const previousSecret = decryptFacebookSecret(integration.previousStatusCallbackSecret);
      if (previousSecret.length > 0 && previousSecret !== currentSecret) {
        await assertExternalApiUrlNetworkSafe(callbackUrl);
        response = await postCallback(
          callbackUrl,
          body,
          sync.providerIdempotencyKey,
          timestamp,
          previousSecret,
        );
      }
    }
  } catch (error) {
    await recordNetworkFailure(sync, attempt, error);
    return;
  }

  if (isSuccessResponse(response)) {
    await markSucceeded(sync.id, String(response.status));
    logger.info("order_confirmation.store_sync_succeeded", {
      syncId: sync.id,
      providerStatus: response.status,
    });
    return;
  }

  await recordDeliveryFailure(sync, attempt, response);
}
