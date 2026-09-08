import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accountFindFirst: vi.fn(),
  transaction: vi.fn(),
  conversationFindFirst: vi.fn(),
  conversationCreate: vi.fn(),
  conversationUpdateMany: vi.fn(),
  messageCreate: vi.fn(),
  upsertCustomer: vi.fn(),
  processMetaMessage: vi.fn(),
}));

vi.mock("@config/prisma", () => ({
  default: {
    whatsAppAccount: { findFirst: mocks.accountFindFirst },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@modules/business/customer/customer.service", () => ({
  upsertCustomerFromConversation: mocks.upsertCustomer,
}));

vi.mock("@modules/meta/core/metaProcessor.service", () => ({
  processMetaMessage: mocks.processMetaMessage,
}));

import {
  importCoexistenceHistoryChunk,
  type CoexistenceHistoryInput,
} from "./whatsappCoexistenceHistory.service";

const historyJob: CoexistenceHistoryInput = {
  platform: "whatsapp",
  type: "whatsapp_coexistence_history",
  wabaId: "waba-1",
  phoneNumberId: "phone-number-id",
  historyChunk: {
    metadata: { phase: 0, chunk_order: 0 },
    threads: [
      {
        id: "201001234567",
        messages: [
          {
            id: "wamid-history-inbound",
            from: "201001234567",
            to: "15551234567",
            timestamp: "1700000000",
            type: "text",
            text: { body: "hello from history" },
          },
          {
            id: "wamid-history-outbound",
            from: "15551234567",
            to: "201001234567",
            timestamp: "2023-11-14T22:13:21.000Z",
            type: "text",
            status: "read",
            text: { body: "reply from history" },
          },
          {
            id: "wamid-history-image",
            from: "201001234567",
            to: "15551234567",
            timestamp: 1700000002,
            type: "image",
            image: { id: "media-history-1", mime_type: "image/jpeg", sha256: "hash-1" },
          },
        ],
      },
    ],
  },
};

describe("WhatsApp Coexistence history importer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const tx = {
      conversation: {
        findFirst: mocks.conversationFindFirst,
        create: mocks.conversationCreate,
        updateMany: mocks.conversationUpdateMany,
      },
      conversationMessage: { create: mocks.messageCreate },
      customer: { create: vi.fn(), update: vi.fn() },
      customerExternalIdentity: { upsert: vi.fn() },
    };
    mocks.transaction.mockImplementation(async (callback: (db: typeof tx) => unknown) => callback(tx));
    mocks.accountFindFirst.mockResolvedValue({ businessProfileId: 42 });
    mocks.conversationFindFirst.mockResolvedValue(null);
    mocks.conversationCreate.mockResolvedValue({ id: 101 });
    mocks.upsertCustomer.mockResolvedValue({ id: 77 });
    mocks.messageCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: Number(mocks.messageCreate.mock.calls.length),
      ...data,
    }));
  });

  it("persists original UTC timestamps, participant roles, read status, and media metadata", async () => {
    const result = await importCoexistenceHistoryChunk(historyJob);

    expect(result).toMatchObject({
      processed: 3,
      imported: 3,
      duplicates: 0,
      skipped: 0,
      conversationIds: [101],
    });
    expect(mocks.messageCreate).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        conversationId: 101,
        role: "user",
        content: "hello from history",
        type: "text",
        externalId: "wamid-history-inbound",
        status: "SENT",
        origin: "whatsapp_coexistence_history",
        createdAt: new Date("2023-11-14T22:13:20.000Z"),
      }),
    });
    expect(mocks.messageCreate).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        role: "agent",
        content: "reply from history",
        status: "READ",
        createdAt: new Date("2023-11-14T22:13:21.000Z"),
      }),
    });
    expect(mocks.messageCreate).toHaveBeenNthCalledWith(3, {
      data: expect.objectContaining({
        role: "user",
        type: "image",
        mediaId: "media-history-1",
        mediaMetadata: { mimeType: "image/jpeg", sha256: "hash-1" },
      }),
    });
    expect(mocks.upsertCustomer).toHaveBeenCalledWith(expect.objectContaining({
      businessProfileId: 42,
      channel: "whatsapp",
      senderId: "201001234567",
      updateInteraction: false,
      activityAt: new Date("2023-11-14T22:13:22.000Z"),
      db: expect.any(Object),
    }));
    expect(mocks.processMetaMessage).not.toHaveBeenCalled();
  });

  it("retains a placeholder marker when historical media has no usable Meta media ID", async () => {
    const input: CoexistenceHistoryInput = {
      ...historyJob,
      historyChunk: {
        ...historyJob.historyChunk,
        threads: [
          {
            id: "201001234567",
            messages: [
              {
                id: "wamid-history-audio-without-id",
                from: "201001234567",
                to: "15551234567",
                timestamp: "1700000003",
                type: "audio",
                audio: { mime_type: "audio/ogg", duration: 4 },
              },
            ],
          },
        ],
      },
    };

    await importCoexistenceHistoryChunk(input);

    expect(mocks.messageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        mediaId: null,
        mediaMetadata: expect.objectContaining({
          placeholder: true,
          placeholderReason: "media_id_unavailable",
        }),
      }),
    });
  });

  it("treats a concurrent WAMID unique conflict as an idempotent duplicate", async () => {
    mocks.messageCreate.mockRejectedValueOnce({ code: "P2002" });

    const result = await importCoexistenceHistoryChunk(historyJob);

    expect(result).toMatchObject({ processed: 3, imported: 2, duplicates: 1, skipped: 0 });
  });

  it("links an existing conversation without overwriting newer activity, read state, or status", async () => {
    const updatedAt = new Date("2026-09-08T10:00:00.000Z");
    mocks.conversationFindFirst.mockResolvedValue({
      id: 303,
      customerId: null,
      updatedAt,
      readAt: new Date("2026-09-08T10:01:00.000Z"),
      status: "RESOLVED",
    });

    await importCoexistenceHistoryChunk(historyJob);

    expect(mocks.conversationCreate).not.toHaveBeenCalled();
    expect(mocks.conversationUpdateMany).toHaveBeenCalledWith({
      where: { id: 303 },
      data: { customerId: 77, updatedAt },
    });
    expect(mocks.conversationUpdateMany.mock.calls[0]?.[0].data).not.toHaveProperty("readAt");
    expect(mocks.conversationUpdateMany.mock.calls[0]?.[0].data).not.toHaveProperty("status");
  });

  it("uses bounded batches without creating a second conversation for a thread that crosses the boundary", async () => {
    const messages = Array.from({ length: 101 }, (_, index) => ({
      id: `wamid-history-batch-${index}`,
      from: "201001234567",
      to: "15551234567",
      timestamp: 1700000000 + index,
      type: "text",
      text: { body: `history ${index}` },
    }));
    const input: CoexistenceHistoryInput = {
      ...historyJob,
      historyChunk: {
        ...historyJob.historyChunk,
        threads: [{ id: "201001234567", messages }],
      },
    };

    const result = await importCoexistenceHistoryChunk(input);

    expect(result).toMatchObject({ processed: 101, imported: 101, duplicates: 0, skipped: 0 });
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.conversationCreate).toHaveBeenCalledTimes(1);
    expect(mocks.messageCreate).toHaveBeenCalledTimes(101);
    expect(mocks.upsertCustomer).toHaveBeenCalledWith(expect.objectContaining({
      activityAt: new Date("2023-11-14T22:15:00.000Z"),
    }));
    expect(mocks.conversationCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        createdAt: new Date("2023-11-14T22:13:20.000Z"),
        updatedAt: new Date("2023-11-14T22:15:00.000Z"),
      }),
    });
  });

  it("deduplicates repeated WAMIDs within one history chunk before writing", async () => {
    const duplicate = historyJob.historyChunk.threads[0]!.messages[0]!;
    const input: CoexistenceHistoryInput = {
      ...historyJob,
      historyChunk: {
        ...historyJob.historyChunk,
        threads: [
          {
            id: "201001234567",
            messages: [...historyJob.historyChunk.threads[0]!.messages, duplicate],
          },
        ],
      },
    };

    const result = await importCoexistenceHistoryChunk(input);

    expect(result).toMatchObject({ processed: 4, imported: 3, duplicates: 1, skipped: 0 });
    expect(mocks.messageCreate).toHaveBeenCalledTimes(3);
  });

  it("skips history messages whose source timestamp is missing or invalid", async () => {
    const input: CoexistenceHistoryInput = {
      ...historyJob,
      historyChunk: {
        ...historyJob.historyChunk,
        threads: [
          {
            id: "201001234567",
            messages: [
              {
                id: "wamid-history-invalid-timestamp",
                from: "201001234567",
                to: "15551234567",
                timestamp: "not-a-timestamp",
                type: "text",
                text: { body: "must not be persisted" },
              },
            ],
          },
        ],
      },
    };

    const result = await importCoexistenceHistoryChunk(input);

    expect(result).toMatchObject({ processed: 0, imported: 0, duplicates: 0, skipped: 1 });
    expect(mocks.messageCreate).not.toHaveBeenCalled();
  });
});
