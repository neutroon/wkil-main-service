import prisma from "@config/prisma";
import { Prisma } from "@prisma/client";
import { hashOrderActionToken } from "./orderConfirmation.crypto";
import type { CanonicalOrderEvent, OrderAction, OrderStatus } from "./orderConfirmation.types";

export type ActiveOrderIntegration = {
  id: number;
  businessProfileId: number;
  signingSecret: string;
  isActive: boolean;
};

export type InsertOrderEventParams = {
  integrationId: number;
  businessProfileId: number;
  externalEventId: string;
  eventType: string;
  schemaVersion: string;
  occurredAt: Date;
  rawPayload: unknown;
};

export type InsertOrderEventResult =
  | { duplicate: false; event: { id: number } }
  | { duplicate: true };

export async function findActiveIntegrationByPublicKey(
  publicKey: string,
): Promise<ActiveOrderIntegration | null> {
  return prisma.orderIntegration.findFirst({
    where: { integrationKey: publicKey, isActive: true },
    select: {
      id: true,
      businessProfileId: true,
      signingSecret: true,
      isActive: true,
    },
  });
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export async function insertOrderEventIfNew(
  params: InsertOrderEventParams,
): Promise<InsertOrderEventResult> {
  try {
    const event = await prisma.orderEvent.create({
      data: {
        integrationId: params.integrationId,
        businessProfileId: params.businessProfileId,
        externalEventId: params.externalEventId,
        eventType: params.eventType,
        schemaVersion: params.schemaVersion,
        occurredAt: params.occurredAt,
        rawPayload: params.rawPayload as any,
        status: "RECEIVED",
      },
    });

    return { duplicate: false, event: { id: event.id } };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return { duplicate: true };
    }

    throw error;
  }
}

export type OrderEventForProcessing = {
  id: number;
  integrationId: number;
  businessProfileId: number;
  externalEventId: string;
  eventType: string;
  schemaVersion: string;
  rawPayload: unknown;
  status: string;
  integration: {
    id: number;
    businessProfileId: number;
    whatsappAccountId: number | null;
    defaultLocale: string;
    storeSyncEnabled: boolean;
  };
};

export type CreateOrderConfirmationWorkflowParams = {
  eventId: number;
  integrationId: number;
  businessProfileId: number;
  externalEventId: string;
  event: CanonicalOrderEvent;
  locale: string;
  confirmTokenHash: string;
  cancelTokenHash: string;
};

export type CreateOrderConfirmationWorkflowResult = {
  created: boolean;
  shouldEnqueueNotification?: boolean;
  order?: { id: number; status: string; businessProfileId: number };
  notification?: { id: number };
};

export async function findOrderEventForProcessing(
  eventId: number,
): Promise<OrderEventForProcessing | null> {
  return prisma.orderEvent.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      integrationId: true,
      businessProfileId: true,
      externalEventId: true,
      eventType: true,
      schemaVersion: true,
      rawPayload: true,
      status: true,
      integration: {
        select: {
          id: true,
          businessProfileId: true,
          whatsappAccountId: true,
          defaultLocale: true,
          storeSyncEnabled: true,
        },
      },
    },
  });
}

function orderSnapshotData(event: CanonicalOrderEvent, locale: string) {
  return {
    orderNumber: event.order.number,
    customerPhone: event.order.customer.phone,
    customerName: event.order.customer.name,
    locale,
    total: event.order.total,
    currency: event.order.currency,
    lineItems: event.order.items as any,
    shippingAddress: event.order.shippingAddress as any,
    metadata: event.order.metadata as any,
    sourceStatus: event.order.sourceStatus,
    paymentMethod: event.order.paymentMethod,
    sourceCreatedAt: new Date(event.occurredAt),
    sourceUpdatedAt: new Date(event.occurredAt),
  };
}

function notificationIdempotencyKey(
  integrationId: number,
  externalEventId: string,
  orderId: number,
): string {
  return `order-confirmation:${integrationId}:${externalEventId}:${orderId}`;
}

async function findExistingWorkflow(
  tx: any,
  orderId: number,
): Promise<CreateOrderConfirmationWorkflowResult> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, businessProfileId: true },
  });
  const notification = await tx.orderNotification.findUnique({
    where: { orderId_kind: { orderId, kind: "CONFIRMATION_REQUEST" } },
    select: { id: true },
  });

  return {
    created: false,
    ...(order ? { order } : {}),
    ...(notification ? { notification } : {}),
  };
}

export async function createOrderConfirmationWorkflow(
  params: CreateOrderConfirmationWorkflowParams,
): Promise<CreateOrderConfirmationWorkflowResult> {
  return prisma.$transaction(async (tx) => {
    const event = await tx.orderEvent.findUnique({
      where: { id: params.eventId },
      select: { status: true, orderId: true },
    });

    if (!event) {
      throw new Error("Order event not found");
    }

    if (event.status === "PROCESSED" && event.orderId) {
      return findExistingWorkflow(tx, event.orderId);
    }

    await tx.orderEvent.updateMany({
      where: {
        id: params.eventId,
        status: { in: ["RECEIVED", "PROCESSING", "FAILED"] },
      },
      data: {
        status: "PROCESSING",
        attemptCount: { increment: 1 },
        lastError: null,
      },
    });

    const snapshot = orderSnapshotData(params.event, params.locale);
    const order = await tx.order.upsert({
      where: {
        integrationId_externalOrderId: {
          integrationId: params.integrationId,
          externalOrderId: params.event.order.id,
        },
      },
      update: snapshot,
      create: {
        integrationId: params.integrationId,
        businessProfileId: params.businessProfileId,
        externalOrderId: params.event.order.id,
        ...snapshot,
      },
      select: { id: true, status: true, businessProfileId: true },
    });

    const existingNotification = await tx.orderNotification.findUnique({
      where: { orderId_kind: { orderId: order.id, kind: "CONFIRMATION_REQUEST" } },
      select: { id: true },
    });

    if (existingNotification) {
      await tx.orderEvent.update({
        where: { id: params.eventId },
        data: {
          status: "PROCESSED",
          orderId: order.id,
          processedAt: new Date(),
          lastError: null,
        },
      });
      return {
        created: false,
        shouldEnqueueNotification: true,
        order,
        notification: existingNotification,
      };
    }

    const notification = await tx.orderNotification.create({
      data: {
        businessProfileId: params.businessProfileId,
        orderId: order.id,
        kind: "CONFIRMATION_REQUEST",
    locale: params.locale,
        idempotencyKey: notificationIdempotencyKey(
          params.integrationId,
          params.externalEventId,
          order.id,
        ),
      },
      select: { id: true },
    });

    await tx.orderActionToken.createMany({
      data: [
        {
          businessProfileId: params.businessProfileId,
          orderId: order.id,
          notificationId: notification.id,
          action: "CONFIRM",
          tokenHash: params.confirmTokenHash,
        },
        {
          businessProfileId: params.businessProfileId,
          orderId: order.id,
          notificationId: notification.id,
          action: "CANCEL",
          tokenHash: params.cancelTokenHash,
        },
      ],
    });

    await tx.orderEvent.update({
      where: { id: params.eventId },
      data: {
        status: "PROCESSED",
        orderId: order.id,
        processedAt: new Date(),
        lastError: null,
      },
    });

    return { created: true, order, notification };
  });
}

export async function markOrderEventRecoverable(
  eventId: number,
  errorMessage: string,
): Promise<void> {
  await prisma.orderEvent.update({
    where: { id: eventId },
    data: { status: "RECEIVED", lastError: errorMessage },
  });
}

export async function markOrderEventFailed(
  eventId: number,
  errorMessage: string,
): Promise<void> {
  await prisma.orderEvent.update({
    where: { id: eventId },
    data: { status: "FAILED", lastError: errorMessage },
  });
}

export type OrderNotificationForSending = {
  id: number;
  businessProfileId: number;
  orderId: number;
  kind: string;
  locale: string;
  status: string;
  renderedVariables: unknown;
  templateConfig: {
    id: number;
    templateName: string;
    languageCode: string;
    variableMapping: unknown;
  } | null;
  order: {
    id: number;
    businessProfileId: number;
    integrationId: number;
    externalOrderId: string;
    orderNumber: string;
    status: string;
    customerPhone: string;
    customerName: string | null;
    locale: string;
    total: unknown;
    currency: string;
    lineItems: unknown;
    shippingAddress: unknown;
    integration: {
      id: number;
      whatsappAccountId: number | null;
      defaultLocale: string;
      storeSyncEnabled: boolean;
      whatsappAccount: {
        id: number;
        phoneNumberId: string;
        accessToken: string;
      } | null;
    };
  };
  actionTokens: Array<{ action: OrderAction; tokenHash: string }>;
};

export async function findNotificationForSending(
  notificationId: number,
): Promise<OrderNotificationForSending | null> {
  return prisma.orderNotification.findUnique({
    where: { id: notificationId },
    select: {
      id: true,
      businessProfileId: true,
      orderId: true,
      kind: true,
      locale: true,
      status: true,
      renderedVariables: true,
      templateConfig: {
        select: {
          id: true,
          templateName: true,
          languageCode: true,
          variableMapping: true,
        },
      },
      order: {
        select: {
          id: true,
          businessProfileId: true,
          integrationId: true,
          externalOrderId: true,
          orderNumber: true,
          status: true,
          customerPhone: true,
          customerName: true,
          locale: true,
          total: true,
          currency: true,
          lineItems: true,
          shippingAddress: true,
          integration: {
            select: {
              id: true,
              whatsappAccountId: true,
              defaultLocale: true,
              storeSyncEnabled: true,
              whatsappAccount: {
                select: { id: true, phoneNumberId: true, accessToken: true },
              },
            },
          },
        },
      },
      actionTokens: { select: { action: true, tokenHash: true } },
    },
  });
}

export async function markNotificationSending(notificationId: number): Promise<boolean> {
  const result = await prisma.orderNotification.updateMany({
    where: {
      id: notificationId,
      status: { in: ["QUEUED", "FAILED"] },
    },
    data: {
      status: "SENDING",
      attemptCount: { increment: 1 },
      lastError: null,
    },
  });

  return result.count > 0;
}

export async function markNotificationQueued(notificationId: number): Promise<void> {
  await prisma.orderNotification.update({
    where: { id: notificationId },
    data: { status: "QUEUED", lastError: null },
  });
}

export async function markNotificationSent(
  notificationId: number,
  providerMessageId: string,
): Promise<void> {
  const message = await prisma.conversationMessage.findUnique({
    where: { externalId: providerMessageId },
    select: { id: true },
  });

  await prisma.orderNotification.update({
    where: { id: notificationId },
    data: {
      status: "SENT",
      providerMessageId,
      conversationMessageId: message?.id,
      sentAt: new Date(),
      lastError: null,
    },
  });
}

export async function markNotificationFailed(
  notificationId: number,
  errorMessage: string,
): Promise<void> {
  await prisma.orderNotification.update({
    where: { id: notificationId },
    data: { status: "FAILED", failedAt: new Date(), lastError: errorMessage },
  });
}

export async function saveNotificationRenderedVariables(
  notificationId: number,
  renderedVariables: unknown,
): Promise<void> {
  await prisma.orderNotification.update({
    where: { id: notificationId },
    data: { renderedVariables: renderedVariables as Prisma.InputJsonValue },
  });
}

export async function findActiveWhatsAppSuppression(
  businessProfileId: number,
  normalizedPhone: string,
): Promise<{ reason: string; source: string } | null> {
  return prisma.whatsAppSuppression.findFirst({
    where: { businessProfileId, normalizedPhone, clearedAt: null },
    select: { reason: true, source: true },
  });
}

export type ClaimOrderActionParams = {
  businessProfileId: number;
  phoneNumberId: string;
  customerPhone: string;
  actionToken: string;
};

export type ClaimOrderActionResult = {
  applied: boolean;
  orderId: number;
  action: OrderAction;
  currentStatus: OrderStatus;
  businessProfileId: number;
  locale?: string;
  storeSyncEnabled?: boolean;
};

export async function claimOrderAction(
  params: ClaimOrderActionParams,
): Promise<ClaimOrderActionResult> {
  const hashedInput = hashOrderActionToken(params.actionToken);
  const token = await prisma.orderActionToken.findFirst({
    where: {
      businessProfileId: params.businessProfileId,
      OR: [{ tokenHash: params.actionToken }, { tokenHash: hashedInput }],
      order: {
        businessProfileId: params.businessProfileId,
        customerPhone: params.customerPhone,
        integration: {
          whatsappAccount: { phoneNumberId: params.phoneNumberId },
        },
      },
    },
    select: {
      id: true,
      action: true,
      order: {
        select: {
          id: true,
          status: true,
          businessProfileId: true,
          locale: true,
          integration: { select: { storeSyncEnabled: true } },
        },
      },
    },
  });

  if (!token) {
    throw new Error("Invalid order action token");
  }

  return prisma.$transaction(async (tx) => {
    const transition = await tx.order.updateMany({
      where: {
        id: token.order.id,
        businessProfileId: params.businessProfileId,
        customerPhone: params.customerPhone,
        status: "AWAITING_CONFIRMATION",
      },
      data: { status: token.action === "CONFIRM" ? "CONFIRMED" : "CANCELED" },
    });

    if (transition.count === 0) {
      const current = await tx.order.findUnique({
        where: { id: token.order.id },
        select: { status: true },
      });
      return {
        applied: false,
        orderId: token.order.id,
        action: token.action,
        currentStatus: current?.status ?? token.order.status,
        businessProfileId: params.businessProfileId,
      };
    }

    await tx.orderActionToken.updateMany({
      where: { id: token.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    return {
      applied: true,
      orderId: token.order.id,
      action: token.action,
      currentStatus: token.action === "CONFIRM" ? "CONFIRMED" : "CANCELED",
      businessProfileId: params.businessProfileId,
      locale: token.order.locale,
      storeSyncEnabled: token.order.integration.storeSyncEnabled,
    };
  });
}

export type CreateAcknowledgementParams = {
  orderId: number;
  businessProfileId: number;
  locale: string;
  action: OrderAction;
};

export async function createAcknowledgementNotification(
  params: CreateAcknowledgementParams,
): Promise<{ created: boolean; notification: { id: number } }> {
  const existing = await prisma.orderNotification.findUnique({
    where: { orderId_kind: { orderId: params.orderId, kind: "ACKNOWLEDGEMENT" } },
    select: { id: true },
  });

  if (existing) return { created: false, notification: existing };

  const notification = await prisma.orderNotification.create({
    data: {
      businessProfileId: params.businessProfileId,
      orderId: params.orderId,
      kind: "ACKNOWLEDGEMENT",
      locale: params.locale,
      renderedVariables: { action: params.action } as Prisma.InputJsonValue,
      idempotencyKey: `order-acknowledgement:${params.orderId}`,
    },
    select: { id: true },
  });

  return { created: true, notification };
}

export async function createPendingStoreSync(
  orderId: number,
  businessProfileId: number,
  requestedStatus: "CONFIRMED" | "CANCELED",
): Promise<{ id: number }> {
  return prisma.orderStoreSync.upsert({
    where: { orderId_requestedStatus: { orderId, requestedStatus } },
    update: {},
    create: {
      orderId,
      businessProfileId,
      requestedStatus,
      status: "PENDING",
      providerIdempotencyKey: `order-status:${orderId}:${requestedStatus}`,
    },
    select: { id: true },
  });
}

export async function findStaleOrderEvents(cutoff: Date): Promise<Array<{ id: number }>> {
  return prisma.orderEvent.findMany({
    where: {
      status: { in: ["RECEIVED", "PROCESSING"] },
      updatedAt: { lt: cutoff },
    },
    select: { id: true },
  });
}

export async function findStaleOrderNotifications(
  cutoff: Date,
): Promise<Array<{ id: number }>> {
  return prisma.orderNotification.findMany({
    where: { status: "SENDING", updatedAt: { lt: cutoff } },
    select: { id: true },
  });
}

export async function clearExpiredOrderEventPayloads(now = new Date()): Promise<void> {
  await prisma.orderEvent.updateMany({
    where: { rawPayload: { not: Prisma.DbNull }, rawPayloadRetentionUntil: { lt: now } },
    data: { rawPayload: Prisma.DbNull },
  });
}
