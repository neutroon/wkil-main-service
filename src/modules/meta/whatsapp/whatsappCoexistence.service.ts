import { z } from "zod";
import {
  coexistenceContactsJobSchema,
  coexistenceHistoryChunkSchema,
  coexistenceHistoryJobSchema,
  coexistenceContactStateSchema,
  type CoexistenceContactState,
  type CoexistenceHistoryChunk,
  type WhatsappCoexistenceContactsJob,
  type WhatsappCoexistenceHistoryJob,
} from "./whatsappCoexistence.schemas";
import { syncCoexistenceContacts } from "./whatsappCoexistenceContacts.service";
import { importCoexistenceHistoryChunk } from "./whatsappCoexistenceHistory.service";
import { syncCoexistenceHistoryImported } from "@modules/realtime/socketSync.service";

export type whatsappCoexistenceHistoryJob = WhatsappCoexistenceHistoryJob;
export type whatsappCoexistenceContactsJob = WhatsappCoexistenceContactsJob;

export const WHATSAPP_COEXISTENCE_QUEUE_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 10_000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
} as const;

type UnknownRecord = Record<string, unknown>;

function hashJobPayload(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function safeJobPart(value: unknown): string {
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}

const routingSchema = z.object({
  wabaId: z.string().trim().min(1),
  phoneNumberId: z.string().trim().min(1),
});

function asRecord(input: unknown): UnknownRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  return input as UnknownRecord;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function normalizedPayload(input: unknown): UnknownRecord {
  const outer = asRecord(input);
  const value = asRecord(outer.value);
  const source = Object.keys(value).length > 0 ? value : outer;
  const metadata = asRecord(source.metadata);

  return {
    ...source,
    wabaId: firstString(source.wabaId, source.waba_id, outer.wabaId, outer.waba_id, outer.entryId),
    phoneNumberId: firstString(
      source.phoneNumberId,
      source.phone_number_id,
      metadata.phone_number_id,
      outer.phoneNumberId,
      outer.phone_number_id,
    ),
  };
}

export function parseCoexistenceHistoryPayload(input: unknown): whatsappCoexistenceHistoryJob[] {
  const payload = normalizedPayload(input);
  const { wabaId, phoneNumberId } = routingSchema.parse(payload);
  const chunks = z
    .array(coexistenceHistoryChunkSchema)
    .parse(payload.history);

  return chunks.map((historyChunk) => ({
    platform: "whatsapp" as const,
    type: "whatsapp_coexistence_history" as const,
    wabaId,
    phoneNumberId,
    historyChunk,
  }));
}

export function parseCoexistenceContactsPayload(input: unknown): whatsappCoexistenceContactsJob {
  const payload = normalizedPayload(input);
  const { wabaId, phoneNumberId } = routingSchema.parse(payload);
  const stateSync = z
    .array(coexistenceContactStateSchema)
    .max(1_000)
    .parse(payload.state_sync);

  return coexistenceContactsJobSchema.parse({
    platform: "whatsapp",
    type: "whatsapp_coexistence_contacts",
    wabaId,
    phoneNumberId,
    stateSync,
  });
}

export function createCoexistenceHistoryJobId(
  job: whatsappCoexistenceHistoryJob,
): string {
  const metadata = (job.historyChunk.metadata || {}) as UnknownRecord;
  return [
    "whatsapp-coexistence-history",
    safeJobPart(job.wabaId),
    safeJobPart(job.phoneNumberId),
    safeJobPart(metadata.phase),
    safeJobPart(metadata.chunk_order),
    hashJobPayload(job.historyChunk),
  ].join("-");
}

export function createCoexistenceContactsJobId(
  job: whatsappCoexistenceContactsJob,
): string {
  return [
    "whatsapp-coexistence-contacts",
    safeJobPart(job.wabaId),
    safeJobPart(job.phoneNumberId),
    hashJobPayload(job.stateSync),
  ].join("-");
}

export async function processCoexistenceHistoryJob(
  payload: unknown,
): Promise<void> {
  const input = coexistenceHistoryJobSchema.parse(payload);
  const summary = await importCoexistenceHistoryChunk(input);
  syncCoexistenceHistoryImported({
    businessProfileId: summary.businessProfileId,
    phoneNumberId: input.phoneNumberId,
    conversationIds: summary.conversationIds,
    importedMessageCount: summary.imported,
    importedContactCount: 0,
  });
}

export async function processCoexistenceContactsJob(
  payload: unknown,
): Promise<void> {
  const input = coexistenceContactsJobSchema.parse(payload);
  const summary = await syncCoexistenceContacts(input);
  syncCoexistenceHistoryImported({
    businessProfileId: summary.businessProfileId,
    phoneNumberId: input.phoneNumberId,
    conversationIds: [],
    importedMessageCount: 0,
    importedContactCount: summary.processed,
  });
}

export type {
  CoexistenceContactState,
  CoexistenceHistoryChunk,
};
