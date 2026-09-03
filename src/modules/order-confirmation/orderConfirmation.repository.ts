import prisma from "@config/prisma";
import { Prisma } from "@prisma/client";
import { hashOrderActionToken, issueOrderActionToken } from "./orderConfirmation.crypto";
import type { CanonicalOrderEvent, OrderAction, OrderStatus } from "./orderConfirmation.types";

export type ActiveOrderIntegration = {
  id: number;
  businessProfileId: number;
  signingSecret: string;
  previousSigningSecret: string | null;
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
      previousSigningSecret: true,
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
  notification?: { id: number; status?: string; attemptCount?: number };
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
    select: { id: true, status: true, attemptCount: true },
  });

  return {
    created: false,
    shouldEnqueueNotification: notification?.status === "QUEUED" && notification.attemptCount === 0,
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
      select: { id: true, status: true, attemptCount: true },
    });

    if (existingNotification) {
      return {
        created: false,
        shouldEnqueueNotification:
          existingNotification.status === "QUEUED" && existingNotification.attemptCount === 0,
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
      select: { id: true, status: true, attemptCount: true },
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

    return { created: true, order, notification };
  });
}

export async function markOrderEventProcessed(
  eventId: number,
  orderId: number,
): Promise<void> {
  await prisma.orderEvent.updateMany({
    where: { id: eventId, status: { in: ["RECEIVED", "PROCESSING"] } },
    data: {
      status: "PROCESSED",
      orderId,
      processedAt: new Date(),
      lastError: null,
    },
  });
}

export async function markOrderEventRecoverable(
  eventId: number,
  errorMessage: string,
): Promise<void> {
  await prisma.orderEvent.update({
    where: { id: eventId },
    data: { status: "RECEIVED", processedAt: null, lastError: errorMessage },
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
      OR: [
        { status: "QUEUED" },
        { status: "FAILED", lastError: null },
        {
          status: "FAILED",
          lastError: { not: "AMBIGUOUS_PROVIDER_DELIVERY" },
        },
      ],
    },
    data: {
      status: "SENDING",
      lastError: null,
      failedAt: null,
    },
  });

  return result.count > 0;
}

export async function markNotificationAttempted(notificationId: number): Promise<void> {
  await prisma.orderNotification.updateMany({
    where: { id: notificationId, status: "SENDING" },
    data: { attemptCount: { increment: 1 } },
  });
}

export async function markNotificationQueued(notificationId: number): Promise<void> {
  await prisma.orderNotification.update({
    where: { id: notificationId },
    data: { status: "QUEUED", lastError: null, failedAt: null },
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
      failedAt: null,
    },
  });
}

export async function reconcileNotificationDeliveryStatus(params: {
  providerMessageId: string;
  status: "SENT" | "DELIVERED" | "READ" | "FAILED";
  error?: string;
  occurredAt?: Date;
}): Promise<void> {
  const occurredAt = params.occurredAt ?? new Date();
  const where: Prisma.OrderNotificationWhereInput =
    params.status === "READ"
      ? {
          providerMessageId: params.providerMessageId,
          status: { in: ["SENT", "DELIVERED", "READ"] },
        }
      : params.status === "DELIVERED"
        ? {
            providerMessageId: params.providerMessageId,
            status: { in: ["SENT", "DELIVERED"] },
          }
        : params.status === "FAILED"
          ? {
              providerMessageId: params.providerMessageId,
              status: { in: ["SENDING", "SENT"] },
            }
          : { providerMessageId: params.providerMessageId, status: "SENDING" as const };
  const data =
    params.status === "READ"
      ? { status: "READ" as const, readAt: occurredAt }
      : params.status === "DELIVERED"
        ? { status: "DELIVERED" as const, deliveredAt: occurredAt }
        : params.status === "FAILED"
          ? {
              status: "FAILED" as const,
              failedAt: occurredAt,
              lastError: params.error || "META_DELIVERY_FAILED",
            }
          : { status: "SENT" as const, sentAt: occurredAt };

  await prisma.orderNotification.updateMany({ where, data });
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
  templateConfigId?: number,
): Promise<void> {
  await prisma.orderNotification.update({
    where: { id: notificationId },
    data: {
      renderedVariables: renderedVariables as Prisma.InputJsonValue,
      ...(templateConfigId === undefined ? {} : { templateConfigId }),
    },
  });
}

export type PreparedOrderActionTokens = {
  confirmToken: string;
  cancelToken: string;
  confirmTokenHash: string;
  cancelTokenHash: string;
};

export async function prepareOrderActionTokensForSend(
  notificationId: number,
): Promise<PreparedOrderActionTokens> {
  const confirm = issueOrderActionToken();
  const cancel = issueOrderActionToken();

  await prisma.$transaction(async (tx) => {
    const notification = await tx.orderNotification.findUnique({
      where: { id: notificationId },
      select: { orderId: true, status: true },
    });

    if (!notification || notification.status !== "SENDING") {
      throw new Error("Order notification is not claimed for sending");
    }

    await tx.orderActionToken.update({
      where: { orderId_action: { orderId: notification.orderId, action: "CONFIRM" } },
      data: { tokenHash: confirm.tokenHash, usedAt: null },
    });
    await tx.orderActionToken.update({
      where: { orderId_action: { orderId: notification.orderId, action: "CANCEL" } },
      data: { tokenHash: cancel.tokenHash, usedAt: null },
    });
  });

  return {
    confirmToken: confirm.token,
    cancelToken: cancel.token,
    confirmTokenHash: confirm.tokenHash,
    cancelTokenHash: cancel.tokenHash,
  };
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
  acknowledgement?: { id: number; status: string; attemptCount: number };
  shouldEnqueueAcknowledgement?: boolean;
};

async function upsertPendingStoreSyncInTransaction(
  tx: any,
  orderId: number,
  businessProfileId: number,
  requestedStatus: "CONFIRMED" | "CANCELED",
): Promise<{ id: number }> {
  return tx.orderStoreSync.upsert({
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

async function upsertAcknowledgementInTransaction(
  tx: any,
  orderId: number,
  businessProfileId: number,
  locale: string,
  action: OrderAction,
): Promise<{ id: number; status: string; attemptCount: number }> {
  return tx.orderNotification.upsert({
    where: { orderId_kind: { orderId, kind: "ACKNOWLEDGEMENT" } },
    update: {},
    create: {
      businessProfileId,
      orderId,
      kind: "ACKNOWLEDGEMENT",
      locale,
      renderedVariables: { action } as Prisma.InputJsonValue,
      idempotencyKey: `order-acknowledgement:${orderId}`,
    },
    select: { id: true, status: true, attemptCount: true },
  });
}

export async function claimOrderAction(
  params: ClaimOrderActionParams,
): Promise<ClaimOrderActionResult> {
  const hashedInput = hashOrderActionToken(params.actionToken);
  const token = await prisma.orderActionToken.findFirst({
    where: {
      businessProfileId: params.businessProfileId,
      tokenHash: hashedInput,
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
    const targetStatus = token.action === "CONFIRM" ? "CONFIRMED" : "CANCELED";
    const transition = await tx.order.updateMany({
      where: {
        id: token.order.id,
        businessProfileId: params.businessProfileId,
        customerPhone: params.customerPhone,
        status: "AWAITING_CONFIRMATION",
      },
      data: { status: targetStatus },
    });

    let currentStatus: OrderStatus = targetStatus;
    if (transition.count === 0) {
      const current = await tx.order.findUnique({
        where: { id: token.order.id },
        select: { status: true },
      });
      currentStatus = (current?.status ?? token.order.status) as OrderStatus;
      if (currentStatus !== targetStatus) {
        return {
          applied: false,
          orderId: token.order.id,
          action: token.action,
          currentStatus,
          businessProfileId: params.businessProfileId,
        };
      }
    }

    if (transition.count > 0) {
      await tx.orderActionToken.updateMany({
        where: { id: token.id, usedAt: null },
        data: { usedAt: new Date() },
      });
    }

    if (token.order.integration.storeSyncEnabled) {
      await upsertPendingStoreSyncInTransaction(
        tx,
        token.order.id,
        params.businessProfileId,
        targetStatus,
      );
    }

    const acknowledgement = await upsertAcknowledgementInTransaction(
      tx,
      token.order.id,
      params.businessProfileId,
      token.order.locale ?? "en",
      token.action,
    );

    return {
      applied: transition.count > 0,
      orderId: token.order.id,
      action: token.action,
      currentStatus,
      businessProfileId: params.businessProfileId,
      locale: token.order.locale,
      storeSyncEnabled: token.order.integration.storeSyncEnabled,
      acknowledgement,
      shouldEnqueueAcknowledgement:
        acknowledgement.status === "QUEUED" && acknowledgement.attemptCount === 0,
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

export async function findUnattemptedQueuedOrderNotifications(
  cutoff: Date,
): Promise<Array<{ id: number }>> {
  return prisma.orderNotification.findMany({
    where: {
      status: "QUEUED",
      updatedAt: { lt: cutoff },
    },
    select: { id: true },
  });
}

export async function findPendingOrderStoreSyncs(
  cutoff: Date,
  now = new Date(),
): Promise<Array<{ id: number }>> {
  return prisma.orderStoreSync.findMany({
    where: {
      status: "PENDING",
      updatedAt: { lt: cutoff },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    select: { id: true },
  });
}

export async function markStaleSendingNotificationsFailed(cutoff: Date): Promise<void> {
  await prisma.orderNotification.updateMany({
    where: { status: "SENDING", updatedAt: { lt: cutoff } },
    data: {
      status: "FAILED",
      failedAt: new Date(),
      lastError: "AMBIGUOUS_PROVIDER_DELIVERY",
    },
  });
}

export async function clearExpiredOrderEventPayloads(now = new Date()): Promise<void> {
  await prisma.orderEvent.updateMany({
    where: { rawPayload: { not: Prisma.DbNull }, rawPayloadRetentionUntil: { lt: now } },
    data: { rawPayload: Prisma.DbNull },
  });
}

const integrationPublicSelect = {
  id: true,
  businessProfileId: true,
  whatsappAccountId: true,
  kind: true,
  integrationKey: true,
  statusCallbackUrl: true,
  isActive: true,
  storeSyncEnabled: true,
  defaultLocale: true,
  createdAt: true,
  updatedAt: true,
  businessProfile: { select: { id: true, name: true } },
  whatsappAccount: {
    select: {
      id: true,
      phoneNumberId: true,
      displayPhoneNumber: true,
      wabaId: true,
      isActive: true,
    },
  },
} as const;

const integrationManagementSelect = {
  ...integrationPublicSelect,
  signingSecret: true,
  previousSigningSecret: true,
  statusCallbackSecret: true,
  previousStatusCallbackSecret: true,
} as const;

export type OrderIntegrationManagementRecord = Prisma.OrderIntegrationGetPayload<{
  select: typeof integrationManagementSelect;
}>;

export type OrderIntegrationPublicRecord = Prisma.OrderIntegrationGetPayload<{
  select: typeof integrationPublicSelect;
}>;

export async function listOrderIntegrations(params: {
  profileIds: number[];
  businessProfileId?: number;
}): Promise<OrderIntegrationPublicRecord[]> {
  if (params.profileIds.length === 0) return [];

  return prisma.orderIntegration.findMany({
    where: {
      businessProfileId:
        params.businessProfileId === undefined
          ? { in: params.profileIds }
          : { in: params.profileIds, equals: params.businessProfileId },
    },
    select: integrationPublicSelect,
    orderBy: { updatedAt: "desc" },
  });
}

export async function findOrderIntegrationForProfiles(
  id: number,
  profileIds: number[],
): Promise<OrderIntegrationManagementRecord | null> {
  if (profileIds.length === 0) return null;

  return prisma.orderIntegration.findFirst({
    where: { id, businessProfileId: { in: profileIds } },
    select: integrationManagementSelect,
  });
}

export type CreateOrderIntegrationRepositoryParams = {
  businessProfileId: number;
  whatsappAccountId?: number | null;
  kind: string;
  integrationKey: string;
  signingSecret: string;
  statusCallbackUrl?: string | null;
  statusCallbackSecret?: string | null;
  isActive: boolean;
  storeSyncEnabled: boolean;
  defaultLocale: string;
};

export async function createOrderIntegration(
  params: CreateOrderIntegrationRepositoryParams,
): Promise<OrderIntegrationManagementRecord> {
  return prisma.orderIntegration.create({
    data: {
      businessProfileId: params.businessProfileId,
      whatsappAccountId: params.whatsappAccountId ?? null,
      kind: params.kind,
      integrationKey: params.integrationKey,
      signingSecret: params.signingSecret,
      statusCallbackUrl: params.statusCallbackUrl ?? null,
      statusCallbackSecret: params.statusCallbackSecret ?? null,
      isActive: params.isActive,
      storeSyncEnabled: params.storeSyncEnabled,
      defaultLocale: params.defaultLocale,
    },
    select: integrationManagementSelect,
  });
}

export type UpdateOrderIntegrationRepositoryParams = {
  id: number;
  businessProfileId: number;
  data: Prisma.OrderIntegrationUpdateInput;
};

export async function updateOrderIntegration(
  params: UpdateOrderIntegrationRepositoryParams,
): Promise<OrderIntegrationManagementRecord> {
  return prisma.orderIntegration.update({
    where: { id: params.id, businessProfileId: params.businessProfileId },
    data: params.data,
    select: integrationManagementSelect,
  });
}

export async function rotateOrderIntegrationSecret(params: {
  id: number;
  businessProfileId: number;
  signingSecret: string;
  previousSigningSecret: string;
}): Promise<OrderIntegrationManagementRecord> {
  return prisma.orderIntegration.update({
    where: { id: params.id, businessProfileId: params.businessProfileId },
    data: {
      signingSecret: params.signingSecret,
      previousSigningSecret: params.previousSigningSecret,
    },
    select: integrationManagementSelect,
  });
}

export type WhatsAppAccountForOrderManagement = {
  id: number;
  businessProfileId: number | null;
  phoneNumberId: string;
  displayPhoneNumber: string;
  wabaId: string;
  accessToken: string;
  isActive: boolean;
};

export async function findWhatsAppAccountForProfile(
  whatsappAccountId: number,
  businessProfileId: number,
): Promise<WhatsAppAccountForOrderManagement | null> {
  return prisma.whatsAppAccount.findFirst({
    where: { id: whatsappAccountId, businessProfileId, isActive: true },
    select: {
      id: true,
      businessProfileId: true,
      phoneNumberId: true,
      displayPhoneNumber: true,
      wabaId: true,
      accessToken: true,
      isActive: true,
    },
  });
}

const templateConfigPublicSelect = {
  id: true,
  businessProfileId: true,
  whatsappAccountId: true,
  eventType: true,
  locale: true,
  templateName: true,
  languageCode: true,
  templateVersion: true,
  isActive: true,
  approvalStatus: true,
  variableMapping: true,
  lastSyncedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type OrderTemplateConfigManagementRecord = Prisma.OrderTemplateConfigGetPayload<{
  select: typeof templateConfigPublicSelect;
}>;

export async function listOrderTemplateConfigs(params: {
  profileIds: number[];
  integrationId: number;
  businessProfileId?: number;
  whatsappAccountId?: number;
  eventType?: string;
  locale?: string;
}): Promise<OrderTemplateConfigManagementRecord[]> {
  if (params.profileIds.length === 0) return [];

  return prisma.orderTemplateConfig.findMany({
    where: {
      businessProfileId:
        params.businessProfileId === undefined
          ? { in: params.profileIds }
          : { in: params.profileIds, equals: params.businessProfileId },
      ...(params.whatsappAccountId === undefined
        ? {}
        : { whatsappAccountId: params.whatsappAccountId }),
      whatsappAccount: {
        orderIntegrations: {
          some: {
            id: params.integrationId,
            ...(params.businessProfileId === undefined
              ? {}
              : { businessProfileId: params.businessProfileId }),
          },
        },
      },
      ...(params.eventType === undefined ? {} : { eventType: params.eventType }),
      ...(params.locale === undefined ? {} : { locale: params.locale }),
    },
    select: templateConfigPublicSelect,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
}

export async function findOrderTemplateConfigForTest(params: {
  id?: number;
  integrationId: number;
  businessProfileId: number;
  whatsappAccountId: number;
  eventType: string;
  locale: string;
}): Promise<OrderTemplateConfigManagementRecord | null> {
  return prisma.orderTemplateConfig.findFirst({
    where: {
      ...(params.id === undefined ? {} : { id: params.id }),
      businessProfileId: params.businessProfileId,
      whatsappAccountId: params.whatsappAccountId,
      eventType: params.eventType,
      locale: params.locale,
      whatsappAccount: {
        orderIntegrations: {
          some: { id: params.integrationId, businessProfileId: params.businessProfileId },
        },
      },
    },
    select: templateConfigPublicSelect,
  });
}

export async function findOrderTemplateConfigByIdForProfiles(
  id: number,
  profileIds: number[],
  integrationId: number,
): Promise<OrderTemplateConfigManagementRecord | null> {
  if (profileIds.length === 0) return null;

  return prisma.orderTemplateConfig.findFirst({
    where: {
      id,
      businessProfileId: { in: profileIds },
      whatsappAccount: { orderIntegrations: { some: { id: integrationId } } },
    },
    select: templateConfigPublicSelect,
  });
}

export type CreateOrderTemplateConfigRepositoryParams = {
  integrationId: number;
  businessProfileId: number;
  whatsappAccountId: number;
  eventType: string;
  locale: string;
  templateName: string;
  languageCode: string;
  templateVersion: number;
  variableMapping: Prisma.InputJsonValue;
  approvalStatus: string;
  isActive: boolean;
};

export async function createOrderTemplateConfig(
  params: CreateOrderTemplateConfigRepositoryParams,
): Promise<OrderTemplateConfigManagementRecord> {
  return prisma.$transaction(async (tx) => {
    const integration = await tx.orderIntegration.findFirst({
      where: {
        id: params.integrationId,
        businessProfileId: params.businessProfileId,
        whatsappAccountId: params.whatsappAccountId,
      },
      select: { id: true },
    });
    if (!integration) {
      throw new Error("WhatsApp account is not configured for this order integration");
    }

    if (params.isActive) {
      await tx.orderTemplateConfig.updateMany({
        where: {
          businessProfileId: params.businessProfileId,
          whatsappAccountId: params.whatsappAccountId,
          eventType: params.eventType,
          locale: params.locale,
          isActive: true,
        },
        data: { isActive: false },
      });
    }

    return tx.orderTemplateConfig.create({
      data: {
        businessProfileId: params.businessProfileId,
        whatsappAccountId: params.whatsappAccountId,
        eventType: params.eventType,
        locale: params.locale,
        templateName: params.templateName,
        languageCode: params.languageCode,
        templateVersion: params.templateVersion,
        variableMapping: params.variableMapping,
        approvalStatus: params.approvalStatus,
        isActive: params.isActive,
      },
      select: templateConfigPublicSelect,
    });
  });
}

export async function updateOrderTemplateConfig(params: {
  id: number;
  integrationId: number;
  businessProfileId: number;
  whatsappAccountId: number;
  data: Prisma.OrderTemplateConfigUpdateInput;
  activateKey?: {
    whatsappAccountId: number;
    eventType: string;
    locale: string;
  };
}): Promise<OrderTemplateConfigManagementRecord> {
  return prisma.$transaction(async (tx) => {
    const integration = await tx.orderIntegration.findFirst({
      where: {
        id: params.integrationId,
        businessProfileId: params.businessProfileId,
        whatsappAccountId: params.whatsappAccountId,
      },
      select: { id: true },
    });
    if (!integration) {
      throw new Error("WhatsApp account is not configured for this order integration");
    }

    if (params.data.isActive === true && params.activateKey) {
      await tx.orderTemplateConfig.updateMany({
        where: {
          businessProfileId: params.businessProfileId,
          whatsappAccountId: params.activateKey.whatsappAccountId,
          eventType: params.activateKey.eventType,
          locale: params.activateKey.locale,
          isActive: true,
          id: { not: params.id },
        },
        data: { isActive: false },
      });
    }

    return tx.orderTemplateConfig.update({
      where: { id: params.id, businessProfileId: params.businessProfileId },
      data: params.data,
      select: templateConfigPublicSelect,
    });
  });
}

const managedOrderSelect = {
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
  metadata: true,
  sourceStatus: true,
  paymentMethod: true,
  sourceCreatedAt: true,
  sourceUpdatedAt: true,
  createdAt: true,
  updatedAt: true,
  events: {
    orderBy: { occurredAt: "desc" as const },
    take: 1,
    select: { externalEventId: true },
  },
  notifications: {
    orderBy: { createdAt: "asc" as const },
    select: {
      id: true,
      kind: true,
      status: true,
      providerMessageId: true,
      conversationMessageId: true,
      attemptCount: true,
      lastError: true,
      queuedAt: true,
      sentAt: true,
      deliveredAt: true,
      readAt: true,
      failedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  },
  storeSyncs: {
    orderBy: { createdAt: "asc" as const },
    select: {
      id: true,
      requestedStatus: true,
      status: true,
      providerStatus: true,
      attemptCount: true,
      lastError: true,
      nextAttemptAt: true,
      startedAt: true,
      completedAt: true,
      failedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  },
} as const;

export type ManagedOrderRecord = Prisma.OrderGetPayload<{ select: typeof managedOrderSelect }>;

export async function listManagedOrders(params: {
  profileIds: number[];
  businessProfileId?: number;
  integrationId?: number;
  status?: string;
  page: number;
  limit: number;
}): Promise<{ data: ManagedOrderRecord[]; meta: { total: number; page: number; limit: number; totalPages: number } }> {
  if (params.profileIds.length === 0) {
    return {
      data: [],
      meta: { total: 0, page: params.page, limit: params.limit, totalPages: 0 },
    };
  }

  const where: Prisma.OrderWhereInput = {
    businessProfileId:
      params.businessProfileId === undefined
        ? { in: params.profileIds }
        : { in: params.profileIds, equals: params.businessProfileId },
    ...(params.integrationId === undefined ? {} : { integrationId: params.integrationId }),
    ...(params.status === undefined ? {} : { status: params.status as any }),
  };
  const [total, data] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      select: managedOrderSelect,
      orderBy: { updatedAt: "desc" },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
    }),
  ]);

  return {
    data,
    meta: {
      total,
      page: params.page,
      limit: params.limit,
      totalPages: Math.ceil(total / params.limit),
    },
  };
}

export async function findManagedOrder(
  id: number,
  profileIds: number[],
): Promise<ManagedOrderRecord | null> {
  if (profileIds.length === 0) return null;

  return prisma.order.findFirst({
    where: { id, businessProfileId: { in: profileIds } },
    select: managedOrderSelect,
  });
}

export async function findNotificationForManagementRetry(
  id: number,
  profileIds: number[],
): Promise<{
  id: number;
  businessProfileId: number;
  kind: string;
  status: string;
  order: { id: number; businessProfileId: number; status: string };
} | null> {
  if (profileIds.length === 0) return null;

  return prisma.orderNotification.findFirst({
    where: { id, businessProfileId: { in: profileIds } },
    select: {
      id: true,
      businessProfileId: true,
      kind: true,
      status: true,
      order: { select: { id: true, businessProfileId: true, status: true } },
    },
  });
}

export async function requeueNotificationForRetry(
  id: number,
  businessProfileId: number,
): Promise<boolean> {
  const result = await prisma.orderNotification.updateMany({
    where: {
      id,
      businessProfileId,
      status: "FAILED",
      OR: [
        {
          kind: "CONFIRMATION_REQUEST",
          order: { status: "AWAITING_CONFIRMATION" },
        },
        {
          kind: "ACKNOWLEDGEMENT",
          order: { status: { in: ["CONFIRMED", "CANCELED"] } },
        },
      ],
    },
    data: { status: "QUEUED", lastError: null, failedAt: null, queuedAt: new Date() },
  });
  return result.count > 0;
}

export async function findStoreSyncForManagementRetry(
  id: number,
  profileIds: number[],
): Promise<{
  id: number;
  businessProfileId: number;
  status: string;
  requestedStatus: string;
  order: { id: number; businessProfileId: number; status: string };
} | null> {
  if (profileIds.length === 0) return null;

  return prisma.orderStoreSync.findFirst({
    where: { id, businessProfileId: { in: profileIds } },
    select: {
      id: true,
      businessProfileId: true,
      status: true,
      requestedStatus: true,
      order: { select: { id: true, businessProfileId: true, status: true } },
    },
  });
}

export async function requeueStoreSyncForRetry(
  id: number,
  businessProfileId: number,
): Promise<boolean> {
  const result = await prisma.orderStoreSync.updateMany({
    where: { id, businessProfileId, status: "FAILED" },
    data: {
      status: "PENDING",
      lastError: null,
      failedAt: null,
      nextAttemptAt: null,
    },
  });
  return result.count > 0;
}

export async function findSystemSettingUpdatedAt(key: string): Promise<Date | null> {
  const setting = await prisma.systemSetting.findUnique({
    where: { key },
    select: { updatedAt: true },
  });
  return setting?.updatedAt ?? null;
}
