import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@config/prisma", () => ({
  default: {
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
    conversationMessage: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    conversation: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
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

import prisma from "@config/prisma";
import { upsertCustomerFromConversation } from "@modules/business/customer/customer.service";
import {
  getOrCreateConversation,
  listConversationMessages,
  saveMessage,
} from "./conversation.service";

const mockedPrisma = prisma as any;
const mockedUpsertCustomer = upsertCustomerFromConversation as any;

async function flushMessageSideEffects() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
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
