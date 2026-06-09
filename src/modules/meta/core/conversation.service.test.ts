import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@config/prisma", () => ({
  default: {
    conversationMessage: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    conversation: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
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
import { saveMessage } from "./conversation.service";

const mockedPrisma = prisma as any;

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
