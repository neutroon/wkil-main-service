import {
  normalizeCustomerPhone,
  upsertCustomerFromConversation,
} from "@modules/business/customer/customer.service";

export type CoexistenceContactAction = "add" | "edit" | "remove";

export type CoexistenceContactStateSync = {
  type?: string | null;
  action: string;
  eventId?: string | null;
  idempotencyKey?: string | null;
  externalId?: string | null;
  contactId?: string | null;
  id?: string | null;
  phone?: string | null;
  phoneNumber?: string | null;
  phone_number?: string | null;
  waId?: string | null;
  wa_id?: string | null;
  displayName?: string | null;
  name?: string | null;
  fullName?: string | null;
  full_name?: string | null;
  metadata?: Record<string, unknown> | null;
  contact?: Record<string, unknown> | null;
  [key: string]: unknown;
};

export type CoexistenceContactsInput = {
  businessProfileId: number;
  phoneNumberId: string;
  contacts?: CoexistenceContactStateSync[];
  events?: CoexistenceContactStateSync[];
  items?: CoexistenceContactStateSync[];
  stateSync?: CoexistenceContactStateSync[];
};

export type CoexistenceContactsJob = CoexistenceContactsInput;

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

function removedMetadata(contact: NormalizedContact) {
  return {
    ...contact.metadata,
    whatsappCoexistence: {
      state: "REMOVED",
      removed: true,
      removedAt: new Date().toISOString(),
      ...(contact.eventId ? { eventId: contact.eventId } : {}),
    },
  };
}

export async function syncCoexistenceContacts(
  input: CoexistenceContactsInput,
): Promise<CoexistenceContactsSummary> {
  const contacts = input.contacts || input.events || input.items || input.stateSync || [];
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

    await upsertCustomerFromConversation({
      businessProfileId: input.businessProfileId,
      channel: "whatsapp",
      senderId: normalized.externalId || normalized.phone || identity,
      customerPhone: normalized.phone,
      customerName: normalized.displayName,
      metadata: normalized.action === "remove" ? removedMetadata(normalized) : normalized.metadata,
      updateInteraction: false,
    });

    summary.processed += 1;
    if (normalized.action === "add") summary.added += 1;
    if (normalized.action === "edit") summary.updated += 1;
    if (normalized.action === "remove") summary.removed += 1;
  }

  return summary;
}
