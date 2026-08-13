import { logger } from "@utils/logger";
import {
  createOrderConfirmationWorkflow,
  findNotificationForSending,
  findOrderEventForProcessing,
  markNotificationFailed,
  markNotificationQueued,
  markNotificationSending,
  markNotificationSent,
  markOrderEventProcessed,
  markOrderEventFailed,
  markOrderEventRecoverable,
  claimOrderAction,
  createPendingStoreSync,
} from "./orderConfirmation.repository";
import { issueOrderActionToken } from "./orderConfirmation.crypto";
import { normalizeCanonicalOrderEvent } from "./orderConfirmation.normalizer";
import {
  enqueueNotification,
  enqueueStoreSync,
} from "./orderConfirmation.queue";
import {
  OrderConfirmationGlobalKillSwitchError,
  OrderConfirmationRateLimitError,
  OrderConfirmationSuppressedError,
  sendAcknowledgementNotification,
  sendConfirmationNotification,
} from "./orderConfirmation.whatsapp.adapter";
import { sendGenericOrderStatusCallback } from "./orderConfirmation.store.adapter";
import type { OrderAction, OrderActionInput, OrderStatus } from "./orderConfirmation.types";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export async function processOrderEvent(eventId: number): Promise<void> {
  const event = await findOrderEventForProcessing(eventId);
  if (!event) {
    throw new Error("Order event not found");
  }
  if (event.status === "PROCESSED") {
    return;
  }

  let normalizedEvent: ReturnType<typeof normalizeCanonicalOrderEvent>;
  try {
    if (event.rawPayload === null || event.rawPayload === undefined) {
      throw new Error("Order event raw payload is no longer available");
    }
    normalizedEvent = normalizeCanonicalOrderEvent(event.rawPayload);
  } catch (error) {
    const message = errorMessage(error);
    await markOrderEventFailed(eventId, message);
    logger.error("order_confirmation.event_normalization_failed", {
      eventId,
      businessProfileId: event.businessProfileId,
      integrationId: event.integrationId,
      error: message,
    });
    return;
  }

  const confirmToken = issueOrderActionToken();
  const cancelToken = issueOrderActionToken();
  const workflow = await createOrderConfirmationWorkflow({
    eventId,
    integrationId: event.integrationId,
    businessProfileId: event.businessProfileId,
    externalEventId: event.externalEventId,
    event: normalizedEvent,
    locale: normalizedEvent.order.customer.locale ?? event.integration.defaultLocale ?? "en",
    confirmTokenHash: confirmToken.tokenHash,
    cancelTokenHash: cancelToken.tokenHash,
  });

  if (!workflow.notification || !workflow.order) {
    return;
  }

  const correlationId = `order-event-${eventId}`;
  if (workflow.created || workflow.shouldEnqueueNotification) {
    try {
      await enqueueNotification(workflow.notification.id, correlationId);
    } catch (error) {
      const message = errorMessage(error);
      await markOrderEventRecoverable(eventId, message);
      logger.error("order_confirmation.event_notification_enqueue_failed", {
        correlationId,
        eventId,
        notificationId: workflow.notification.id,
        error: message,
      });
      throw error;
    }
  }

  await markOrderEventProcessed(eventId, workflow.order.id);
}

export async function sendOrderNotification(notificationId: number): Promise<void> {
  const notification = await findNotificationForSending(notificationId);
  if (!notification || ["SENT", "DELIVERED", "READ"].includes(notification.status)) {
    return;
  }

  const claimed = await markNotificationSending(notificationId);
  if (claimed === false) {
    return;
  }

  try {
    const result =
      notification.kind === "ACKNOWLEDGEMENT"
        ? await sendAcknowledgementNotification(notificationId)
        : await sendConfirmationNotification(notificationId);
    await markNotificationSent(notificationId, result.providerMessageId);
  } catch (error) {
    const code = errorCode(error);
    if (error instanceof OrderConfirmationRateLimitError || code === "ORDER_CONFIRMATION_RATE_LIMIT") {
      await markNotificationQueued(notificationId);
      throw error;
    }

    if (
      error instanceof OrderConfirmationGlobalKillSwitchError ||
      code === "GLOBAL_KILL_SWITCH"
    ) {
      await markNotificationFailed(notificationId, "GLOBAL_KILL_SWITCH");
      return;
    }

    if (error instanceof OrderConfirmationSuppressedError || code === "WHATSAPP_SUPPRESSED") {
      await markNotificationFailed(notificationId, errorMessage(error));
      return;
    }

    const message = errorMessage(error);
    await markNotificationFailed(notificationId, message);
    throw error;
  }
}

export async function processOrderAction(input: OrderActionInput): Promise<{
  orderId: number;
  action: OrderAction;
  applied: boolean;
  currentStatus: OrderStatus;
}> {
  const result = await claimOrderAction(input);

  if (result.acknowledgement && result.shouldEnqueueAcknowledgement) {
    await enqueueNotification(
      result.acknowledgement.id,
      input.correlationId,
    );
  }

  if (result.applied && result.storeSyncEnabled) {
    const requestedStatus = result.action === "CONFIRM" ? "CONFIRMED" : "CANCELED";
    const sync = await createPendingStoreSync(
      result.orderId,
      result.businessProfileId,
      requestedStatus,
    );
    await enqueueStoreSync(sync.id, input.correlationId);
  }

  if (!result.applied) {
    return {
      orderId: result.orderId,
      action: result.action,
      applied: false,
      currentStatus: result.currentStatus as OrderStatus,
    };
  }

  return {
    orderId: result.orderId,
    action: result.action,
    applied: true,
    currentStatus: result.currentStatus as OrderStatus,
  };
}

export async function processStoreSync(syncId: number): Promise<void> {
  await sendGenericOrderStatusCallback(syncId);
}
