import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);
const scalarTimestamp = z.union([z.number().finite(), nonEmptyString]);

export const coexistenceHistoryMessageSchema = z
  .object({
    id: nonEmptyString,
    timestamp: scalarTimestamp.optional(),
  })
  .passthrough();

export const coexistenceHistoryThreadSchema = z
  .object({
    id: nonEmptyString,
    messages: z.array(coexistenceHistoryMessageSchema).min(1),
  })
  .passthrough();

export const coexistenceHistoryChunkSchema = z
  .object({
    metadata: z
      .object({
        phase: scalarTimestamp.optional(),
        chunk_order: scalarTimestamp.optional(),
        progress: scalarTimestamp.optional(),
      })
      .passthrough()
      .optional(),
    threads: z.array(coexistenceHistoryThreadSchema).min(1),
  })
  .passthrough();

export const coexistenceContactStateSchema = z
  .object({
    type: nonEmptyString,
    action: nonEmptyString,
  })
  .passthrough();

export const coexistenceHistoryJobSchema = z
  .object({
    platform: z.literal("whatsapp"),
    type: z.literal("whatsapp_coexistence_history"),
    wabaId: nonEmptyString,
    phoneNumberId: nonEmptyString,
    historyChunk: coexistenceHistoryChunkSchema,
  })
  .strict();

export const coexistenceContactsJobSchema = z
  .object({
    platform: z.literal("whatsapp"),
    type: z.literal("whatsapp_coexistence_contacts"),
    wabaId: nonEmptyString,
    phoneNumberId: nonEmptyString,
    stateSync: z.array(coexistenceContactStateSchema).min(1).max(1_000),
  })
  .strict();

export type CoexistenceHistoryMessage = z.infer<typeof coexistenceHistoryMessageSchema>;
export type CoexistenceHistoryThread = z.infer<typeof coexistenceHistoryThreadSchema>;
export type CoexistenceHistoryChunk = z.infer<typeof coexistenceHistoryChunkSchema>;
export type CoexistenceContactState = z.infer<typeof coexistenceContactStateSchema>;
export type WhatsappCoexistenceHistoryJob = z.infer<typeof coexistenceHistoryJobSchema>;
export type WhatsappCoexistenceContactsJob = z.infer<typeof coexistenceContactsJobSchema>;
export type whatsappCoexistenceHistoryJob = WhatsappCoexistenceHistoryJob;
export type whatsappCoexistenceContactsJob = WhatsappCoexistenceContactsJob;
