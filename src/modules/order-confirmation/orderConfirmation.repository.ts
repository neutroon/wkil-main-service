import prisma from "@config/prisma";

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
