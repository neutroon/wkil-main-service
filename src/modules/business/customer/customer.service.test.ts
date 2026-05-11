import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCustomerForUser,
  updateCustomerForUser,
  updateCustomerFromSavedDetails,
  upsertCustomerFromConversation,
} from "./customer.service";

vi.mock("@config/prisma", () => ({
  Prisma: { JsonNull: null },
  default: {
    customerExternalIdentity: {
      findUnique: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    customer: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
    conversation: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@modules/auth/user/user.service", () => ({
  getAccessibleProfileIds: vi.fn(),
}));

import prisma from "@config/prisma";
import { getAccessibleProfileIds } from "@modules/auth/user/user.service";

const mockedPrisma = prisma as any;

describe("customer service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAccessibleProfileIds).mockResolvedValue([1]);
    mockedPrisma.customerExternalIdentity.findUnique.mockResolvedValue(null);
    mockedPrisma.customerExternalIdentity.create.mockResolvedValue({ id: 1 } as never);
    mockedPrisma.customerExternalIdentity.upsert.mockImplementation((args: any) =>
      Promise.resolve({
        id: 1,
        businessProfileId: args.create.businessProfileId,
        customerId: args.create.customerId,
        channel: args.create.channel,
        externalId: args.create.externalId,
      }),
    );
    mockedPrisma.conversation.updateMany.mockResolvedValue({ count: 1 } as never);
  });

  it("creates a customer from the first conversation and links the conversation", async () => {
    mockedPrisma.customer.findUnique.mockResolvedValue(null);
    mockedPrisma.customer.create.mockResolvedValue({
      id: 10,
      businessProfileId: 1,
      displayName: "Nour",
      phone: null,
      normalizedPhone: null,
      email: null,
      normalizedEmail: null,
      externalIds: { web: ["web-1"] },
      lastInteractionAt: new Date(),
    } as never);

    const customer = await upsertCustomerFromConversation({
      businessProfileId: 1,
      conversationId: 55,
      channel: "web",
      senderId: "web-1",
      customerName: "Nour",
    });

    expect(customer.id).toBe(10);
    expect(mockedPrisma.customer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        businessProfileId: 1,
        displayName: "Nour",
        primaryChannel: "web",
        externalIds: { web: ["web-1"] },
      }),
    });
    expect(mockedPrisma.customerExternalIdentity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          businessProfileId: 1,
          customerId: 10,
          channel: "web",
          externalId: "web-1",
        }),
      }),
    );
    expect(mockedPrisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 55, businessProfileId: 1 },
      data: { customerId: 10 },
    });
  });

  it("does not relink an already connected conversation when saving details", async () => {
    const conversation = {
      id: 88,
      businessProfileId: 1,
      customerId: 30,
      channel: "messenger",
      senderId: "psid-1",
      customerName: "Mona",
      customerPhone: null,
      customerAvatar: null,
    };
    const existing = {
      id: 30,
      businessProfileId: 1,
      displayName: "Mona",
      phone: null,
      normalizedPhone: null,
      email: null,
      normalizedEmail: null,
      capturedFields: { source: "chat" },
    };
    mockedPrisma.conversation.findFirst.mockResolvedValue(conversation as never);
    mockedPrisma.customer.findFirst.mockResolvedValue(existing as never);
    mockedPrisma.customer.update.mockResolvedValue({
      ...existing,
      capturedFields: { source: "chat", interest: "pricing" },
    } as never);

    await updateCustomerFromSavedDetails({
      businessProfileId: 1,
      conversationId: 88,
      details: { interest: "pricing" },
    });

    expect(mockedPrisma.conversation.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.customerExternalIdentity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          businessProfileId: 1,
          customerId: 30,
          channel: "messenger",
          externalId: "psid-1",
        }),
      }),
    );
  });

  it("maps another WhatsApp conversation with the same phone to the existing customer", async () => {
    const existing = {
      id: 20,
      businessProfileId: 1,
      displayName: "+20100111222",
      phone: "+20100111222",
      normalizedPhone: "+20100111222",
      email: null,
      normalizedEmail: null,
      avatarUrl: null,
      primaryChannel: "whatsapp",
      externalIds: { whatsapp: ["20100111222"] },
      lastInteractionAt: new Date("2026-01-01"),
    };
    mockedPrisma.customer.findUnique.mockResolvedValue(existing as never);
    mockedPrisma.customer.update.mockResolvedValue({
      ...existing,
      externalIds: { whatsapp: ["20100111222", "20100111222@wa"] },
    } as never);

    const customer = await upsertCustomerFromConversation({
      businessProfileId: 1,
      conversationId: 77,
      channel: "whatsapp",
      senderId: "20100111222@wa",
      customerPhone: "+20 100 111 222",
    });

    expect(customer.id).toBe(20);
    expect(mockedPrisma.customer.create).not.toHaveBeenCalled();
    expect(mockedPrisma.customer.update).toHaveBeenCalledWith({
      where: { id: 20 },
      data: expect.objectContaining({
        phone: "+20100111222",
        normalizedPhone: "+20100111222",
      }),
    });
    expect(mockedPrisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 77, businessProfileId: 1 },
      data: { customerId: 20 },
    });
  });

  it("enriches the existing customer when the agent saves captured details", async () => {
    const conversation = {
      id: 88,
      businessProfileId: 1,
      customerId: 30,
      channel: "messenger",
      senderId: "psid-1",
      customerName: "Mona",
      customerPhone: null,
      customerAvatar: null,
    };
    const existing = {
      id: 30,
      businessProfileId: 1,
      displayName: "Mona",
      phone: null,
      normalizedPhone: null,
      email: null,
      normalizedEmail: null,
      capturedFields: { source: "chat" },
    };
    mockedPrisma.conversation.findFirst.mockResolvedValue(conversation as never);
    mockedPrisma.customer.findFirst.mockResolvedValue(existing as never);
    mockedPrisma.customer.update.mockResolvedValue({
      ...existing,
      capturedFields: { source: "chat", interest: "pricing" },
    } as never);

    await updateCustomerFromSavedDetails({
      businessProfileId: 1,
      conversationId: 88,
      details: {
        interest: "pricing",
        idempotencyKey: "hidden",
        conversationId: 88,
        customerId: 30,
      },
    });

    expect(mockedPrisma.customer.update).toHaveBeenCalledWith({
      where: { id: 30 },
      data: expect.objectContaining({
        capturedFields: { source: "chat", interest: "pricing" },
      }),
    });
    expect(mockedPrisma.conversation.updateMany).not.toHaveBeenCalled();
  });

  it("does not expose customers outside the user's accessible profiles", async () => {
    mockedPrisma.customer.findFirst.mockResolvedValue(null);

    await expect(getCustomerForUser(5, 99)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(mockedPrisma.customer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 99, businessProfileId: { in: [1] } },
      }),
    );
  });

  it("updates and deletes saved captured fields for an accessible customer", async () => {
    const baseCustomer = {
      id: 30,
      businessProfileId: 1,
      displayName: "Mona",
      phone: null,
      email: null,
      avatarUrl: null,
      primaryChannel: "web",
      status: "ACTIVE",
      notes: null,
      capturedFields: { interest: "pricing", budget: "100" },
      externalIdentities: [],
      lastInteractionAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      businessProfile: {
        id: 1,
        name: "PagesPilot",
        customerMemoryFields: [],
      },
      conversations: [],
      _count: { conversations: 0 },
    };
    mockedPrisma.customer.findFirst
      .mockResolvedValueOnce(baseCustomer as never)
      .mockResolvedValueOnce({
        ...baseCustomer,
        capturedFields: { interest: "enterprise" },
      } as never);
    mockedPrisma.customer.update.mockResolvedValue({
      ...baseCustomer,
      capturedFields: { interest: "enterprise" },
    } as never);

    const updated = await updateCustomerForUser(5, 30, {
      capturedFieldUpdates: {
        interest: "enterprise",
        budget: null,
      },
    });

    expect(mockedPrisma.customer.update).toHaveBeenCalledWith({
      where: { id: 30 },
      data: expect.objectContaining({
        capturedFields: { interest: "enterprise" },
      }),
    });
    expect(updated.capturedFields).toEqual({ interest: "enterprise" });
  });
});
