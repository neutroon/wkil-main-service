import { beforeEach, describe, expect, it, vi } from "vitest";

const queueMocks = vi.hoisted(() => ({
  add: vi.fn(),
  getState: vi.fn(),
  getJobCounts: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
}));

const contactSyncMocks = vi.hoisted(() => ({
  syncCoexistenceContacts: vi.fn(),
}));

const historyImportMocks = vi.hoisted(() => ({
  importCoexistenceHistoryChunk: vi.fn(),
}));

const socketSyncMocks = vi.hoisted(() => ({
  syncCoexistenceHistoryImported: vi.fn(),
  syncSocketFromMessage: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Queue: class MockQueue {
    add(...args: unknown[]) {
      return queueMocks.add(...args);
    }

    getJobCounts(...args: unknown[]) {
      return queueMocks.getJobCounts(...args);
    }
  },
  Worker: class MockWorker {},
  QueueEvents: class MockQueueEvents {},
  Job: class MockJob {},
}));

vi.mock("@config/redis", () => ({
  bullConnection: { host: "redis.test", port: 6379 },
  bullQueuePrefix: "test-prefix",
}));

vi.mock("@utils/logger", () => ({
  logger: {
    info: queueMocks.loggerInfo,
    error: queueMocks.loggerError,
    warn: queueMocks.loggerWarn,
  },
}));

vi.mock("@modules/meta/core/metaProcessor.service", () => ({
  processMetaMessage: vi.fn(),
  processVisualJob: vi.fn(),
}));

vi.mock("@modules/media/services/mediaLibrary.service", () => ({
  registerAssetWithMeta: vi.fn(),
}));

vi.mock("./whatsappCoexistenceContacts.service", () => contactSyncMocks);
vi.mock("./whatsappCoexistenceHistory.service", () => historyImportMocks);
vi.mock("@modules/realtime/socketSync.service", () => socketSyncMocks);

import {
  createCoexistenceContactsJobId,
  createCoexistenceHistoryJobId,
  parseCoexistenceContactsPayload,
  parseCoexistenceHistoryPayload,
  processCoexistenceContactsJob,
  processCoexistenceHistoryJob,
  WHATSAPP_COEXISTENCE_QUEUE_OPTIONS,
} from "./whatsappCoexistence.service";
import { enqueueMetaJob } from "../core/meta.queue";

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
  beforeEach(() => {
    vi.clearAllMocks();
    queueMocks.add.mockResolvedValue({
      id: "queued-job-id",
      getState: queueMocks.getState,
    });
    queueMocks.getState.mockResolvedValue("waiting");
    queueMocks.getJobCounts.mockResolvedValue({ waiting: 1 });
  });

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

  it("dispatches normalized history and contacts to their dedicated importers", async () => {
    const historyJob = parseCoexistenceHistoryPayload(historyPayload)[0]!;
    const contactsJob = parseCoexistenceContactsPayload({
      wabaId: "waba-1",
      metadata: { phone_number_id: "phone-number-id" },
      state_sync: [{ type: "contact", action: "add", contact: { wa_id: "201001234567" } }],
    });

    historyImportMocks.importCoexistenceHistoryChunk.mockResolvedValue({
      businessProfileId: 42,
      processed: 1,
      imported: 1,
      duplicates: 0,
      skipped: 0,
      conversationIds: [101],
    });
    await expect(processCoexistenceHistoryJob(historyJob)).resolves.toBeUndefined();
    expect(historyImportMocks.importCoexistenceHistoryChunk).toHaveBeenCalledWith(historyJob);
    expect(socketSyncMocks.syncCoexistenceHistoryImported).toHaveBeenCalledTimes(1);
    expect(socketSyncMocks.syncCoexistenceHistoryImported).toHaveBeenCalledWith({
      businessProfileId: 42,
      phoneNumberId: "phone-number-id",
      conversationIds: [101],
      importedMessageCount: 1,
      importedContactCount: 0,
    }, expect.stringContaining("whatsapp_coexistence_history:"));
    expect(socketSyncMocks.syncCoexistenceHistoryImported).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("whatsapp-coexistence-history-"),
    );
    expect(socketSyncMocks.syncSocketFromMessage).not.toHaveBeenCalled();
    contactSyncMocks.syncCoexistenceContacts.mockResolvedValue({
      businessProfileId: 42,
      processed: 1,
      added: 1,
      updated: 0,
      removed: 0,
      duplicates: 0,
      skipped: 0,
    });
    await expect(processCoexistenceContactsJob(contactsJob)).resolves.toBeUndefined();
    expect(contactSyncMocks.syncCoexistenceContacts).toHaveBeenCalledWith(contactsJob);
    expect(socketSyncMocks.syncCoexistenceHistoryImported).toHaveBeenCalledTimes(2);
    expect(socketSyncMocks.syncCoexistenceHistoryImported).toHaveBeenNthCalledWith(2, {
      businessProfileId: 42,
      phoneNumberId: "phone-number-id",
      conversationIds: [],
      importedMessageCount: 0,
      importedContactCount: 1,
    }, expect.stringContaining("whatsapp_coexistence_contacts:"));
    expect(socketSyncMocks.syncCoexistenceHistoryImported).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.stringContaining("whatsapp-coexistence-contacts-"),
    );
    expect(socketSyncMocks.syncSocketFromMessage).not.toHaveBeenCalled();
    await expect(processCoexistenceHistoryJob({ type: "invalid" })).rejects.toThrow();
  });

  it("forwards BullMQ options and skips only post-enqueue diagnostics for coexistence jobs", async () => {
    const historyJob = parseCoexistenceHistoryPayload(historyPayload)[0]!;

    await enqueueMetaJob(historyJob, {
      jobId: "coexistence-job-1",
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 500 },
      skipPostEnqueueDiagnostics: true,
    });

    expect(queueMocks.add).toHaveBeenCalledWith(
      "whatsapp_coexistence_history",
      { type: "whatsapp_coexistence_history", payload: historyJob },
      {
        delay: 0,
        jobId: "coexistence-job-1",
        attempts: 3,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    );
    expect(queueMocks.getState).not.toHaveBeenCalled();
    expect(queueMocks.getJobCounts).not.toHaveBeenCalled();
    expect(queueMocks.loggerInfo).toHaveBeenCalledWith(
      "meta.queue.enqueued",
      expect.objectContaining({ type: "whatsapp_coexistence_history" }),
    );

    await enqueueMetaJob({ platform: "whatsapp", type: "messaging", messageText: "live" }, { jobId: "live-job" });

    expect(queueMocks.getState).toHaveBeenCalledTimes(1);
    expect(queueMocks.getJobCounts).toHaveBeenCalledTimes(1);
  });
});
