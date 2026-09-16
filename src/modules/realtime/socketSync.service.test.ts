import { beforeEach, describe, expect, it, vi } from "vitest";

const socketMocks = vi.hoisted(() => ({
  emitToBusiness: vi.fn(),
  emitToConversation: vi.fn(),
  importEventCreate: vi.fn(),
  importEventFindUnique: vi.fn(),
  importEventUpdateMany: vi.fn(),
  importEventRecords: new Map<string, any>(),
}));

vi.mock("@config/prisma", () => ({
  default: {
    whatsAppCoexistenceImportEvent: {
      create: socketMocks.importEventCreate,
      findUnique: socketMocks.importEventFindUnique,
      updateMany: socketMocks.importEventUpdateMany,
    },
  },
}));

vi.mock("./socket", () => ({
  emitToBusiness: socketMocks.emitToBusiness,
  emitToConversation: socketMocks.emitToConversation,
}));

vi.mock("@utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

import { syncCoexistenceHistoryImported, syncManualReply } from "./socketSync.service";

describe("Manual reply realtime synchronization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits persisted message, delivery status, and human-control state", () => {
    const message = {
      id: 503,
      conversationId: 45,
      role: "agent",
      content: "Human reply",
      status: "SENT",
      externalId: "mid.out-1",
    };

    syncManualReply({
      businessProfileId: 10,
      conversationId: 45,
      channel: "messenger",
      message,
    });

    const basePayload = { conversationId: 45, channel: "messenger", message };
    expect(socketMocks.emitToBusiness).toHaveBeenCalledWith(10, "new_message", basePayload);
    expect(socketMocks.emitToConversation).toHaveBeenCalledWith(45, "new_message", basePayload);
    expect(socketMocks.emitToBusiness).toHaveBeenCalledWith(10, "message_status", {
      conversationId: 45,
      messageId: 503,
      status: "SENT",
      externalId: "mid.out-1",
    });
    expect(socketMocks.emitToBusiness).toHaveBeenCalledWith(10, "ai_toggle_updated", {
      conversationId: 45,
      aiEnabled: false,
    });
  });
});

describe("Coexistence import realtime synchronization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketMocks.importEventRecords.clear();
    const eventRecordKey = (record: { businessProfileId: number; phoneNumberId: string; eventKey: string }) =>
      `${record.businessProfileId}:${record.phoneNumberId}:${record.eventKey}`;

    socketMocks.importEventCreate.mockImplementation(({ data }: { data: { eventKey: string } }) => {
      const key = eventRecordKey(data as typeof data & { businessProfileId: number; phoneNumberId: string });
      if (socketMocks.importEventRecords.has(key)) {
        const error = Object.assign(new Error("duplicate event claim"), { code: "P2002" });
        return Promise.reject(error);
      }
      const record = {
        id: socketMocks.importEventRecords.size + 1,
        ...data,
        deliveredAt: null,
        leaseUntil: null,
        leaseToken: null,
        attempts: 0,
      };
      socketMocks.importEventRecords.set(key, record);
      return Promise.resolve(record);
    });
    socketMocks.importEventFindUnique.mockImplementation(({ where }: { where: Record<string, any> }) => {
      const compound = where.businessProfileId_phoneNumberId_eventKey;
      return Promise.resolve(
        socketMocks.importEventRecords.get(eventRecordKey(compound)) ?? null,
      );
    });
    socketMocks.importEventUpdateMany.mockImplementation(({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
      const record = Array.from(socketMocks.importEventRecords.values()).find(
        (candidate) =>
          candidate.businessProfileId === where.businessProfileId &&
          candidate.phoneNumberId === where.phoneNumberId &&
          candidate.eventKey === where.eventKey,
      );
      if (!record) return Promise.resolve({ count: 0 });
      if (where.deliveredAt === null && record.deliveredAt !== null) {
        return Promise.resolve({ count: 0 });
      }
      if (where.leaseToken !== undefined && record.leaseToken !== where.leaseToken) {
        return Promise.resolve({ count: 0 });
      }
      const leaseExpiry = where.OR?.find((condition: Record<string, any>) => condition.leaseUntil?.lte)?.leaseUntil.lte;
      if (leaseExpiry && record.leaseUntil && record.leaseUntil > leaseExpiry) {
        return Promise.resolve({ count: 0 });
      }
      if (data.attempts?.increment) record.attempts += data.attempts.increment;
      if ("leaseToken" in data) record.leaseToken = data.leaseToken;
      if ("leaseUntil" in data) record.leaseUntil = data.leaseUntil;
      if ("deliveredAt" in data) record.deliveredAt = data.deliveredAt;
      return Promise.resolve({ count: 1 });
    });
  });

  it("emits one business-room event with the stable bulk import payload", async () => {
    const input = {
      businessProfileId: 42,
      phoneNumberId: "phone-number-id",
      conversationIds: [101, 202],
      importedMessageCount: 3,
      importedContactCount: 0,
    };

    await syncCoexistenceHistoryImported(input, "whatsapp-coexistence-history-job-1");

    expect(socketMocks.emitToBusiness).toHaveBeenCalledTimes(1);
    expect(socketMocks.emitToBusiness).toHaveBeenCalledWith(
      42,
      "whatsapp_history_imported",
      input,
    );
    expect(socketMocks.emitToConversation).not.toHaveBeenCalled();
  });

  it("emits one event for duplicate deliveries of the same stable job key", async () => {
    const input = {
      businessProfileId: 42,
      phoneNumberId: "phone-number-id",
      conversationIds: [101],
      importedMessageCount: 1,
      importedContactCount: 0,
    };

    await syncCoexistenceHistoryImported(input, "whatsapp-coexistence-history-job-2");
    await syncCoexistenceHistoryImported(input, "whatsapp-coexistence-history-job-2");

    expect(socketMocks.emitToBusiness).toHaveBeenCalledTimes(1);
  });

  it("suppresses concurrent deliveries with one durable event claim", async () => {
    const input = {
      businessProfileId: 42,
      phoneNumberId: "phone-number-id",
      conversationIds: [101],
      importedMessageCount: 1,
      importedContactCount: 0,
    };

    await Promise.all([
      syncCoexistenceHistoryImported(input, "whatsapp-coexistence-history-job-3"),
      syncCoexistenceHistoryImported(input, "whatsapp-coexistence-history-job-3"),
    ]);

    expect(socketMocks.importEventCreate).toHaveBeenCalledTimes(2);
    expect(socketMocks.emitToBusiness).toHaveBeenCalledTimes(1);
  });

  it("reclaims a pending payload after a worker crash before socket delivery", async () => {
    const input = {
      businessProfileId: 42,
      phoneNumberId: "phone-number-id",
      conversationIds: [202],
      importedMessageCount: 0,
      importedContactCount: 0,
    };
    const storedPayload = {
      businessProfileId: 42,
      phoneNumberId: "phone-number-id",
      conversationIds: [101],
      importedMessageCount: 3,
      importedContactCount: 0,
    };
    const duplicateError = Object.assign(new Error("duplicate event claim"), { code: "P2002" });

    socketMocks.importEventCreate.mockRejectedValueOnce(duplicateError);
    const recordKey = `42:phone-number-id:whatsapp-coexistence-history-job-4`;
    socketMocks.importEventRecords.set(recordKey, {
      id: 1,
      businessProfileId: 42,
      phoneNumberId: "phone-number-id",
      eventKey: "whatsapp-coexistence-history-job-4",
      payload: storedPayload,
      deliveredAt: null,
      leaseUntil: new Date(Date.now() - 1),
      leaseToken: "crashed-worker-lease",
    });

    await syncCoexistenceHistoryImported(input, "whatsapp-coexistence-history-job-4");

    expect(socketMocks.importEventFindUnique).toHaveBeenCalledTimes(1);
    expect(socketMocks.importEventUpdateMany).toHaveBeenCalled();
    expect(socketMocks.emitToBusiness).toHaveBeenCalledWith(
      42,
      "whatsapp_history_imported",
      storedPayload,
    );
  });
});
