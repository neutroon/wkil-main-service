import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";

vi.mock("@config/prisma", () => ({
  default: {
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    conversationMessage: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    conversation: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
    customer: {
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@modules/business/customer/customer.service", () => ({
  upsertCustomerFromConversation: vi.fn(),
}));

vi.mock("@modules/auth/user/user.service", () => ({
  getAccessibleProfileIds: vi.fn(),
}));

vi.mock("@utils/logger", () => ({
  logger: {
    warn: vi.fn(),
  },
}));

const followUpMocks = vi.hoisted(() => ({
  cancelConversationFollowUps: vi.fn(),
}));

const realtimeMocks = vi.hoisted(() => ({
  syncManualReply: vi.fn(),
}));

vi.mock("@modules/follow-up/followUp.service", () => followUpMocks);
vi.mock("@modules/realtime/socketSync.service", () => realtimeMocks);

import prisma from "@config/prisma";
import { upsertCustomerFromConversation } from "@modules/business/customer/customer.service";
import {
  getOrCreateConversation,
  listConversationMessages,
  saveManualReplyAndTakeHumanControl,
  saveMessage,
} from "./conversation.service";
import { ProviderDeliveryRejectedError } from "@middlewares/errorHandler.middleware";

const mockedPrisma = prisma as any;
const mockedUpsertCustomer = upsertCustomerFromConversation as any;

async function flushMessageSideEffects() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

function manualReplyRequestHash() {
  return createHash("sha256").update(JSON.stringify({
    content: "Human reply",
    isPrivate: false,
    origin: "messenger_manual_reply",
  })).digest("hex");
}

describe("saveMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.conversationMessage.create.mockResolvedValue({
      id: 202,
      conversationId: 45,
      role: "model",
      content: "hello",
    });
    mockedPrisma.conversation.update.mockResolvedValue({
      id: 45,
      businessProfileId: 10,
      customerId: 99,
      channel: "web",
      updatedAt: new Date("2026-06-09T01:00:00.000Z"),
    });
    mockedPrisma.customer.updateMany.mockResolvedValue({ count: 1 });
  });

  it("awaits only the durable message insert before returning", async () => {
    const saved = await saveMessage(45, "model", "hello", {
      status: "SENT",
      aiReasoning: "reason",
    });

    expect(saved).toMatchObject({ id: 202, conversationId: 45 });
    expect(mockedPrisma.conversationMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversationId: 45,
        role: "model",
        content: "hello",
        status: "SENT",
        aiReasoning: "reason",
      }),
    });
    expect(mockedPrisma.conversation.update).not.toHaveBeenCalled();
    expect(mockedPrisma.customer.updateMany).not.toHaveBeenCalled();

    await flushMessageSideEffects();

    expect(mockedPrisma.conversation.update).toHaveBeenCalledWith({
      where: { id: 45 },
      data: { updatedAt: expect.any(Date) },
      select: {
        id: true,
        businessProfileId: true,
        customerId: true,
        channel: true,
        updatedAt: true,
      },
    });
    expect(mockedPrisma.customer.updateMany).toHaveBeenCalledWith({
      where: { id: 99 },
      data: { lastInteractionAt: expect.any(Date) },
    });
  });
});

describe("saveManualReplyAndTakeHumanControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.$transaction.mockImplementation(async (callback: (db: any) => unknown) => callback(mockedPrisma));
    mockedPrisma.conversation.updateMany.mockResolvedValue({ count: 1 });
    mockedPrisma.conversationMessage.create.mockResolvedValue({
      id: 503,
      conversationId: 45,
      role: "agent",
      content: "Human reply",
      status: "SENDING",
      externalId: null,
    });
    mockedPrisma.conversationMessage.updateMany.mockResolvedValue({ count: 1 });
    mockedPrisma.conversationMessage.findFirst.mockResolvedValue(null);
    mockedPrisma.conversation.update.mockResolvedValue({
      id: 45,
      businessProfileId: 10,
      customerId: null,
      channel: "messenger",
      updatedAt: new Date("2026-09-16T09:00:00.000Z"),
    });
    followUpMocks.cancelConversationFollowUps.mockResolvedValue(2);
  });

  it("atomically persists the agent message and conditionally transfers control", async () => {
    const deliver = vi.fn().mockResolvedValue({ externalId: "mid.out-1" });
    const saved = await saveManualReplyAndTakeHumanControl({
      businessProfileId: 10,
      conversationId: 45,
      channel: "messenger",
      content: "Human reply",
      isPrivate: false,
      origin: "messenger_manual_reply",
      idempotencyKey: "manual-reply-key-0001",
      deliver,
    });

    expect(mockedPrisma.$transaction).toHaveBeenCalledOnce();
    expect(mockedPrisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 45, businessProfileId: 10 },
      data: { aiEnabled: false },
    });
    expect(mockedPrisma.conversationMessage.create).toHaveBeenCalledWith({
      data: {
        conversationId: 45,
        role: "agent",
        content: "Human reply",
        status: "SENDING",
        isPrivate: false,
        origin: "messenger_manual_reply",
        manualReplyIdempotencyKey: "manual-reply-key-0001",
        manualReplyRequestHash: manualReplyRequestHash(),
      },
    });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      id: 503,
      role: "agent",
      status: "SENDING",
    }));
    expect(mockedPrisma.conversationMessage.updateMany).toHaveBeenCalledWith({
      where: { id: 503, conversationId: 45, status: "SENDING" },
      data: { status: "SENT", externalId: "mid.out-1" },
    });
    expect(saved).toMatchObject({ id: 503, role: "agent", status: "SENT", externalId: "mid.out-1" });
    expect(followUpMocks.cancelConversationFollowUps).toHaveBeenCalledWith(45);
    expect(realtimeMocks.syncManualReply).toHaveBeenCalledWith({
      businessProfileId: 10,
      conversationId: 45,
      channel: "messenger",
      message: expect.objectContaining({ id: 503, status: "SENT", externalId: "mid.out-1" }),
    });
  });

  it("does not persist when the conversation scope disappears before the transaction", async () => {
    mockedPrisma.conversation.updateMany.mockResolvedValue({ count: 0 });

    await expect(saveManualReplyAndTakeHumanControl({
      businessProfileId: 10,
      conversationId: 45,
      channel: "messenger",
      content: "Human reply",
      isPrivate: false,
      origin: "messenger_manual_reply",
      idempotencyKey: "manual-reply-key-0001",
      deliver: vi.fn(),
    })).rejects.toThrow("Manual reply conversation scope is no longer available");

    expect(mockedPrisma.conversationMessage.create).not.toHaveBeenCalled();
    expect(realtimeMocks.syncManualReply).not.toHaveBeenCalled();
  });

  it("keeps the durable human-control transition when queue cleanup races or fails", async () => {
    followUpMocks.cancelConversationFollowUps.mockRejectedValue(new Error("queue unavailable"));
    const deliver = vi.fn().mockResolvedValue({ externalId: "mid.out-1" });

    const saved = await saveManualReplyAndTakeHumanControl({
      businessProfileId: 10,
      conversationId: 45,
      channel: "messenger",
      content: "Human reply",
      isPrivate: false,
      origin: "messenger_manual_reply",
      idempotencyKey: "manual-reply-key-0001",
      deliver,
    });

    expect(saved).toMatchObject({ id: 503, role: "agent" });
    expect(realtimeMocks.syncManualReply).toHaveBeenNthCalledWith(1, expect.objectContaining({
      message: expect.objectContaining({ status: "SENDING" }),
    }));
    expect(realtimeMocks.syncManualReply).toHaveBeenNthCalledWith(2, expect.objectContaining({
      message: expect.objectContaining({ status: "SENT", externalId: "mid.out-1" }),
    }));
  });

  it("marks a known provider rejection failed without losing human control", async () => {
    const deliver = vi.fn().mockRejectedValue(new ProviderDeliveryRejectedError("Meta rejected send"));

    await expect(saveManualReplyAndTakeHumanControl({
      businessProfileId: 10,
      conversationId: 45,
      channel: "messenger",
      content: "Human reply",
      isPrivate: false,
      origin: "messenger_manual_reply",
      idempotencyKey: "manual-reply-key-0001",
      deliver,
    })).rejects.toThrow("Meta rejected send");

    expect(mockedPrisma.conversationMessage.updateMany).toHaveBeenCalledWith({
      where: { id: 503, conversationId: 45, status: "SENDING" },
      data: { status: "FAILED" },
    });
    expect(mockedPrisma.conversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { aiEnabled: false },
    }));
    expect(realtimeMocks.syncManualReply).toHaveBeenLastCalledWith(expect.objectContaining({
      message: expect.objectContaining({ status: "FAILED" }),
    }));
  });

  it("keeps an accepted provider send in SENDING when local confirmation fails", async () => {
    const deliver = vi.fn().mockResolvedValue({ externalId: "mid.out-1" });
    mockedPrisma.conversationMessage.updateMany.mockRejectedValue(new Error("database unavailable"));

    await expect(saveManualReplyAndTakeHumanControl({
      businessProfileId: 10,
      conversationId: 45,
      channel: "messenger",
      content: "Human reply",
      isPrivate: false,
      origin: "messenger_manual_reply",
      idempotencyKey: "manual-reply-key-0001",
      deliver,
    })).rejects.toMatchObject({ name: "CustomerDeliveryAmbiguousError" });

    expect(deliver).toHaveBeenCalledOnce();
  });

  it("keeps an unknown transport failure SENDING and reports an ambiguous outcome", async () => {
    const networkError = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    const deliver = vi.fn().mockRejectedValue(networkError);

    await expect(saveManualReplyAndTakeHumanControl({
      businessProfileId: 10,
      conversationId: 45,
      channel: "messenger",
      content: "Human reply",
      isPrivate: false,
      origin: "messenger_manual_reply",
      idempotencyKey: "manual-reply-key-0001",
      deliver,
    })).rejects.toMatchObject({ name: "CustomerDeliveryAmbiguousError" });

    expect(mockedPrisma.conversationMessage.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: { status: "FAILED" },
    }));
  });

  it("reuses the concurrent winner for the same idempotency key without another provider call", async () => {
    const duplicate = Object.assign(new Error("duplicate"), { code: "P2002" });
    mockedPrisma.$transaction.mockRejectedValueOnce(duplicate);
    mockedPrisma.conversationMessage.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 504,
        conversationId: 45,
        role: "agent",
        content: "Human reply",
        status: "SENDING",
        externalId: null,
        manualReplyIdempotencyKey: "manual-reply-key-0001",
        manualReplyRequestHash: manualReplyRequestHash(),
      });
    const deliver = vi.fn();

    const saved = await saveManualReplyAndTakeHumanControl({
      businessProfileId: 10,
      conversationId: 45,
      channel: "messenger",
      content: "Human reply",
      isPrivate: false,
      origin: "messenger_manual_reply",
      idempotencyKey: "manual-reply-key-0001",
      deliver,
    });

    expect(saved).toMatchObject({ id: 504, status: "SENDING" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("rejects conflicting reuse of a manual-reply idempotency key", async () => {
    mockedPrisma.conversationMessage.findFirst.mockResolvedValue({
      id: 504,
      conversationId: 45,
      role: "agent",
      content: "Different reply",
      status: "SENT",
      externalId: "mid.other",
      manualReplyIdempotencyKey: "manual-reply-key-0001",
      manualReplyRequestHash: "different-request-hash",
    });

    await expect(saveManualReplyAndTakeHumanControl({
      businessProfileId: 10,
      conversationId: 45,
      channel: "messenger",
      content: "Human reply",
      isPrivate: false,
      origin: "messenger_manual_reply",
      idempotencyKey: "manual-reply-key-0001",
      deliver: vi.fn(),
    })).rejects.toMatchObject({ statusCode: 409 });

    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("shared conversation identity locking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serializes concurrent live identity creation so history and inbound writes share one conversation", async () => {
    const rows: any[] = [];
    let nextId = 500;
    let lockHeld = false;
    const waiters: Array<() => void> = [];
    const acquireLock = async () => {
      if (!lockHeld) {
        lockHeld = true;
        return;
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
    };
    const releaseLock = () => {
      const next = waiters.shift();
      if (next) next();
      else lockHeld = false;
    };

    mockedPrisma.$transaction.mockImplementation(async (callback: (db: any) => unknown) => {
      try {
        return await callback(mockedPrisma);
      } finally {
        releaseLock();
      }
    });
    mockedPrisma.$executeRaw.mockImplementation(acquireLock);
    mockedPrisma.conversation.findFirst.mockImplementation(async () => {
      await Promise.resolve();
      return rows[0] ?? null;
    });
    mockedPrisma.conversation.create.mockImplementation(async ({ data }: { data: any }) => {
      await Promise.resolve();
      const row = {
        id: nextId++,
        ...data,
        customerId: null,
        status: "OPEN",
        channel: data.channel,
      };
      rows.push(row);
      return row;
    });
    mockedUpsertCustomer.mockResolvedValue({ id: 900 });

    const [historyConversation, liveConversation] = await Promise.all([
      getOrCreateConversation("phone-number-id", "201001234567", 42, {
        channel: "whatsapp",
        customerPhone: "201001234567",
      }),
      getOrCreateConversation("phone-number-id", "201001234567", 42, {
        channel: "whatsapp",
        customerPhone: "201001234567",
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(mockedPrisma.conversation.create).toHaveBeenCalledTimes(1);
    expect(historyConversation.id).toBe(liveConversation.id);
    expect(mockedPrisma.$executeRaw).toHaveBeenCalledTimes(2);
  });
});

describe("listConversationMessages cursor pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.conversation.findUnique.mockResolvedValue({
      id: 45,
      senderId: "201001234567",
      pageId: "phone-number-id",
      channel: "whatsapp",
    });
  });

  it("resolves numeric cursors by timestamp so older history survives a newer live message ID", async () => {
    const liveCreatedAt = new Date("2026-09-08T10:00:00.000Z");
    const historyCreatedAt = new Date("2024-01-01T00:00:00.000Z");
    mockedPrisma.conversationMessage.findMany
      .mockResolvedValueOnce([
        {
          id: 100,
          conversationId: 45,
          role: "user",
          content: "live",
          type: "text",
          mediaId: null,
          mediaMetadata: null,
          status: "SENT",
          aiReasoning: null,
          handoffCategory: null,
          intent: null,
          isPrivate: false,
          origin: null,
          createdAt: liveCreatedAt,
          conversation: { id: 45, channel: "whatsapp", postId: null, externalId: null },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 50,
          conversationId: 45,
          role: "user",
          content: "history",
          type: "text",
          mediaId: null,
          mediaMetadata: null,
          status: "SENT",
          aiReasoning: null,
          handoffCategory: null,
          intent: null,
          isPrivate: false,
          origin: "whatsapp_coexistence_history",
          createdAt: historyCreatedAt,
          conversation: { id: 45, channel: "whatsapp", postId: null, externalId: null },
        },
      ]);
    mockedPrisma.conversationMessage.findUnique.mockResolvedValue({
      id: 100,
      conversationId: 45,
      createdAt: liveCreatedAt,
    });

    const firstPage = await listConversationMessages(45, 1);
    const secondPage = await listConversationMessages(45, 1, firstPage.meta.nextCursor!);

    expect(firstPage.meta.nextCursor).toBe(100);
    expect(secondPage.data[0]?.id).toBe(50);
    expect(mockedPrisma.conversationMessage.findUnique).toHaveBeenCalledWith({
      where: { id: 100 },
      select: { id: true, conversationId: true, createdAt: true },
    });
    expect(mockedPrisma.conversationMessage.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: {
        conversationId: 45,
        OR: [
          { createdAt: { lt: liveCreatedAt } },
          { createdAt: liveCreatedAt, id: { lt: 100 } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 1,
    }));
  });
});
