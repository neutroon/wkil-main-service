import prisma from "@config/prisma";
import {
  normalizeCustomerPhone,
  upsertCustomerFromConversation,
} from "@modules/business/customer/customer.service";
import {
  type WhatsappCoexistenceContactsJob,
} from "./whatsappCoexistence.schemas";

export type CoexistenceContactAction = "add" | "edit" | "remove";

export type CoexistenceContactStateSync = WhatsappCoexistenceContactsJob["stateSync"][number];
export type CoexistenceContactsInput = WhatsappCoexistenceContactsJob;
export type CoexistenceContactsJob = WhatsappCoexistenceContactsJob;

export type CoexistenceContactsSummary = {
  processed: number;
  added: number;
  updated: number;
  removed: number;
  duplicates: number;
  skipped: number;
};

type NormalizedContact = {
  action: CoexistenceContactAction;
  eventId: string | null;
  externalId: string | null;
  phone: string | null;
  displayName: string | null;
  metadata?: Record<string, unknown>;
};

type CustomerMetadata = Record<string, unknown>;

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    const text = cleanString(value);
    if (text) return text;
  }
  return null;
}

function normalizeContact(event: CoexistenceContactStateSync): NormalizedContact | null {
  const nested = asRecord(event.contact) || {};
  const kind = firstString(event.type, nested.type);
  if (kind && kind.toLowerCase() !== "contact") return null;

  const action = firstString(event.action, nested.action)?.toLowerCase() as CoexistenceContactAction | undefined;
  if (!action || !["add", "edit", "remove"].includes(action)) return null;

  const externalId = firstString(
    event.externalId,
    event.contactId,
    event.id,
    nested.externalId,
    nested.contactId,
    nested.id,
    nested.waId,
    nested.wa_id,
  );
  const phone = firstString(
    event.phone,
    event.phoneNumber,
    event.phone_number,
    event.waId,
    event.wa_id,
    nested.phone,
    nested.phoneNumber,
    nested.phone_number,
    nested.waId,
    nested.wa_id,
    externalId,
  );
  const profile = asRecord(nested.profile);
  const displayName = firstString(
    event.displayName,
    event.name,
    event.fullName,
    event.full_name,
    nested.displayName,
    nested.name,
    nested.fullName,
    nested.full_name,
    profile?.name,
  );
  const metadata = asRecord(event.metadata) || asRecord(nested.metadata) || undefined;
  const eventId = firstString(event.eventId, event.idempotencyKey, nested.eventId);

  if (!externalId && !phone) return null;
  return { action, eventId, externalId, phone, displayName, metadata };
}

function contactIdentity(contact: NormalizedContact) {
  if (contact.eventId) return `event:${contact.eventId}`;
  return [
    "contact",
    contact.action,
    contact.externalId || "",
    normalizeCustomerPhone(contact.phone) || contact.phone || "",
  ].join(":");
}

function processedEventIds(metadata: unknown): string[] {
  const root = asRecord(asRecord(metadata)?.whatsappCoexistence);
  return Array.isArray(root?.processedEventIds)
    ? root.processedEventIds.filter((value): value is string => typeof value === "string")
    : [];
}

function mergeContactMetadata(
  current: unknown,
  incoming: Record<string, unknown> | undefined,
  contact: NormalizedContact,
  identity: string,
): CustomerMetadata {
  const currentMetadata = asRecord(current) || {};
  const incomingMetadata = incoming || {};
  const currentState = asRecord(currentMetadata.whatsappCoexistence) || {};
  const incomingState = asRecord(incomingMetadata.whatsappCoexistence) || {};
  const eventIds = Array.from(
    new Set([
      ...processedEventIds(currentMetadata),
      ...processedEventIds(incomingMetadata),
      identity,
    ]),
  );
  const nextState: CustomerMetadata = {
    ...currentState,
    ...incomingState,
    processedEventIds: eventIds,
  };

  if (contact.action === "remove") {
    nextState.state = "REMOVED";
    nextState.removed = true;
    nextState.removedAt = new Date().toISOString();
    if (contact.eventId) nextState.eventId = contact.eventId;
  } else {
    delete nextState.state;
    delete nextState.removed;
    delete nextState.removedAt;
    delete nextState.eventId;
  }

  return {
    ...currentMetadata,
    ...incomingMetadata,
    whatsappCoexistence: nextState,
  };
}

async function findContactCustomer(params: {
  businessProfileId: number;
  externalId: string | null;
  normalizedPhone: string | null;
}) {
  if (params.externalId) {
    const identity = await prisma.customerExternalIdentity.findUnique({
      where: {
        businessProfileId_channel_externalId: {
          businessProfileId: params.businessProfileId,
          channel: "whatsapp",
          externalId: params.externalId,
        },
      },
      include: { customer: true },
    });
    if (identity?.customer) return identity.customer;
  }

  if (params.normalizedPhone) {
    return prisma.customer.findUnique({
      where: {
        businessProfileId_normalizedPhone: {
          businessProfileId: params.businessProfileId,
          normalizedPhone: params.normalizedPhone,
        },
      },
    });
  }

  return null;
}

export async function syncCoexistenceContacts(
  input: CoexistenceContactsInput,
): Promise<CoexistenceContactsSummary> {
  const account = await prisma.whatsAppAccount.findFirst({
    where: {
      phoneNumberId: input.phoneNumberId,
      isActive: true,
      businessProfileId: { not: null },
    },
    select: { businessProfileId: true },
  });
  if (!account?.businessProfileId) {
    throw new Error("WhatsApp account is not linked to a business profile");
  }

  const contacts = input.stateSync;
  const seen = new Set<string>();
  const summary: CoexistenceContactsSummary = {
    processed: 0,
    added: 0,
    updated: 0,
    removed: 0,
    duplicates: 0,
    skipped: 0,
  };

  for (const event of contacts) {
    const normalized = normalizeContact(event);
    if (!normalized) {
      summary.skipped += 1;
      continue;
    }

    const identity = contactIdentity(normalized);
    if (seen.has(identity)) {
      summary.duplicates += 1;
      continue;
    }
    seen.add(identity);

    const existing = await findContactCustomer({
      businessProfileId: account.businessProfileId,
      externalId: normalized.externalId,
      normalizedPhone: normalizeCustomerPhone(normalized.phone),
    });
    if (processedEventIds(existing?.metadata).includes(identity)) {
      summary.duplicates += 1;
      continue;
    }

    const metadata = mergeContactMetadata(
      existing?.metadata,
      normalized.metadata,
      normalized,
      identity,
    );

    await upsertCustomerFromConversation({
      businessProfileId: account.businessProfileId,
      channel: "whatsapp",
      senderId: normalized.externalId || normalized.phone || identity,
      customerPhone: normalized.phone,
      customerName: normalized.displayName,
      metadata,
      updateInteraction: false,
    });

    summary.processed += 1;
    if (normalized.action === "add") summary.added += 1;
    if (normalized.action === "edit") summary.updated += 1;
    if (normalized.action === "remove") summary.removed += 1;
  }

  return summary;
}
