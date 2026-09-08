import { describe, expect, it } from "vitest";

import {
  createCoexistenceContactsJobId,
  createCoexistenceHistoryJobId,
  parseCoexistenceContactsPayload,
  parseCoexistenceHistoryPayload,
  processCoexistenceContactsJob,
  processCoexistenceHistoryJob,
  WHATSAPP_COEXISTENCE_QUEUE_OPTIONS,
} from "./whatsappCoexistence.service";

const historyPayload = {
  wabaId: "waba-1",
  metadata: {
    phone_number_id: "phone-number-id",
    display_phone_number: "+15551234567",
  },
  history: [
    {
      metadata: { phase: 0, chunk_order: 0, progress: 50 },
      threads: [
        {
          id: "201001234567",
          messages: [
            {
              id: "wamid-history-1",
              from: "201001234567",
              to: "15551234567",
              timestamp: "1700000000",
              type: "text",
              text: { body: "first historical message" },
            },
          ],
        },
        {
          id: "201009876543",
          messages: [
            {
              id: "wamid-history-2",
              from: "15551234567",
              to: "201009876543",
              timestamp: "1700000001",
              type: "image",
              image: { id: "media-history-1", caption: "historical image" },
            },
          ],
        },
      ],
    },
    {
      metadata: { phase: 0, chunk_order: 1, progress: 100 },
      threads: [
        {
          id: "201001234567",
          messages: [
            {
              id: "wamid-history-3",
              from: "201001234567",
              to: "15551234567",
              timestamp: "1700000002",
              type: "text",
              text: { body: "second historical message" },
            },
          ],
        },
      ],
    },
  ],
};

describe("WhatsApp Coexistence payload contracts", () => {
  it("parses every history chunk while preserving messages from multiple threads", () => {
    const parsed = parseCoexistenceHistoryPayload(historyPayload);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      platform: "whatsapp",
      type: "whatsapp_coexistence_history",
      wabaId: "waba-1",
      phoneNumberId: "phone-number-id",
      historyChunk: historyPayload.history[0],
    });
    expect(parsed[0]?.historyChunk.threads).toHaveLength(2);
    expect(parsed[0]?.historyChunk.threads[1]?.messages[0]?.id).toBe("wamid-history-2");
    expect(parsed[1]?.historyChunk.metadata?.chunk_order).toBe(1);
  });

  it("parses a bounded contacts state-sync payload without discarding contact fields", () => {
    const parsed = parseCoexistenceContactsPayload({
      wabaId: "waba-1",
      metadata: { phone_number_id: "phone-number-id" },
      state_sync: [
        {
          type: "contact",
          action: "add",
          contact: {
            wa_id: "201001234567",
            full_name: "Mona Customer",
            phone_number: "+201001234567",
          },
        },
        {
          type: "contact",
          action: "remove",
          contact: { wa_id: "201009876543" },
        },
      ],
    });

    expect(parsed).toEqual({
      platform: "whatsapp",
      type: "whatsapp_coexistence_contacts",
      wabaId: "waba-1",
      phoneNumberId: "phone-number-id",
      stateSync: [
        {
          type: "contact",
          action: "add",
          contact: {
            wa_id: "201001234567",
            full_name: "Mona Customer",
            phone_number: "+201001234567",
          },
        },
        {
          type: "contact",
          action: "remove",
          contact: { wa_id: "201009876543" },
        },
      ],
    });
  });

  it("rejects malformed history and contacts payloads at the queue boundary", () => {
    expect(() =>
      parseCoexistenceHistoryPayload({
        metadata: { phone_number_id: "phone-number-id" },
        history: [{ metadata: {}, threads: [{ id: "thread-1", messages: [{ id: "wamid-1" }] }] }],
      }),
    ).toThrow();

    expect(() =>
      parseCoexistenceHistoryPayload({
        wabaId: "waba-1",
        metadata: { phone_number_id: "phone-number-id" },
        history: [{ metadata: {}, threads: [{ id: "thread-1" }] }],
      }),
    ).toThrow();

    expect(() =>
      parseCoexistenceContactsPayload({
        wabaId: "waba-1",
        metadata: { phone_number_id: "phone-number-id" },
        state_sync: "not-an-array",
      }),
    ).toThrow();

    expect(() =>
      parseCoexistenceHistoryPayload({
        wabaId: "waba-1",
        metadata: { phone_number_id: "phone-number-id" },
        history: [{ metadata: {}, threads: [] }],
      }),
    ).toThrow();
  });

  it("creates stable job IDs for the same chunk and different IDs for different chunks", () => {
    const parsedHistory = parseCoexistenceHistoryPayload(historyPayload);
    const contacts = parseCoexistenceContactsPayload({
      wabaId: "waba-1",
      metadata: { phone_number_id: "phone-number-id" },
      state_sync: [{ type: "contact", action: "add", contact: { wa_id: "201001234567" } }],
    });

    expect(createCoexistenceHistoryJobId(parsedHistory[0]!)).toBe(
      createCoexistenceHistoryJobId(parsedHistory[0]!),
    );
    expect(createCoexistenceHistoryJobId(parsedHistory[0]!)).not.toBe(
      createCoexistenceHistoryJobId(parsedHistory[1]!),
    );
    expect(createCoexistenceContactsJobId(contacts)).toBe(
      createCoexistenceContactsJobId(contacts),
    );
  });

  it("uses retry and retention settings appropriate for asynchronous sync imports", () => {
    expect(WHATSAPP_COEXISTENCE_QUEUE_OPTIONS).toEqual({
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
    });
  });

  it("validates normalized history and contacts jobs at the worker dispatch hooks", async () => {
    const historyJob = parseCoexistenceHistoryPayload(historyPayload)[0]!;
    const contactsJob = parseCoexistenceContactsPayload({
      wabaId: "waba-1",
      metadata: { phone_number_id: "phone-number-id" },
      state_sync: [{ type: "contact", action: "add", contact: { wa_id: "201001234567" } }],
    });

    await expect(processCoexistenceHistoryJob(historyJob)).resolves.toBeUndefined();
    await expect(processCoexistenceContactsJob(contactsJob)).resolves.toBeUndefined();
    await expect(processCoexistenceHistoryJob({ type: "invalid" })).rejects.toThrow();
  });
});
