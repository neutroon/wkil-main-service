import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCustomerForUser,
  listCustomers,
  reconcileCustomerStatusFromConversations,
  setCustomerStatus,
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
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
    conversation: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    businessProfile: {
      findUnique: vi.fn(),
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

  it("promotes phone-like saved details into the customer phone fields", async () => {
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
      phone: "+20 100 111 2222",
      normalizedPhone: "+201001112222",
      capturedFields: {
        source: "chat",
        whatsappNumber: "+20 100 111 2222",
      },
    } as never);

    await updateCustomerFromSavedDetails({
      businessProfileId: 1,
      conversationId: 88,
      details: {
        whatsappNumber: "+20 100 111 2222",
      },
    });

    expect(mockedPrisma.customer.update).toHaveBeenCalledWith({
      where: { id: 30 },
      data: expect.objectContaining({
        phone: "+20 100 111 2222",
        normalizedPhone: "+201001112222",
        capturedFields: {
          source: "chat",
          whatsappNumber: "+20 100 111 2222",
        },
      }),
    });
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

  it("filters customers to records with saved phone numbers", async () => {
    mockedPrisma.customer.count.mockResolvedValue(0 as never);
    mockedPrisma.customer.findMany.mockResolvedValue([] as never);

    await listCustomers({
      userId: 5,
      hasPhone: true,
      limit: 50,
    });

    expect(mockedPrisma.customer.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        AND: [
          {
            AND: [
              { phone: { not: null } },
              { phone: { not: "" } },
            ],
          },
        ],
      }),
    });
    expect(mockedPrisma.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          businessProfileId: { in: [1] },
          AND: expect.any(Array),
        }),
      }),
    );
  });

  it("filters customers to records with non-empty saved details", async () => {
    mockedPrisma.customer.count.mockResolvedValue(0 as never);
    mockedPrisma.customer.findMany.mockResolvedValue([] as never);

    await listCustomers({
      userId: 5,
      status: "captured",
      limit: 50,
    });

    expect(mockedPrisma.customer.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        AND: [
          {
            AND: [
              { capturedFields: { not: null } },
              { NOT: { capturedFields: { equals: {} } } },
            ],
          },
        ],
      }),
    });
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
        name: "Wkil",
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

  it("syncs manually edited phone-like captured fields to the customer phone", async () => {
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
      capturedFields: {},
      externalIdentities: [],
      lastInteractionAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      businessProfile: {
        id: 1,
        name: "Wkil",
        customerMemoryFields: [],
      },
      conversations: [],
      _count: { conversations: 0 },
    };
    mockedPrisma.customer.findFirst
      .mockResolvedValueOnce(baseCustomer as never)
      .mockResolvedValueOnce({
        ...baseCustomer,
        phone: "0100 111 2222",
        capturedFields: { customerPhone: "0100 111 2222" },
      } as never);
    mockedPrisma.customer.update.mockResolvedValue({
      ...baseCustomer,
      phone: "0100 111 2222",
      capturedFields: { customerPhone: "0100 111 2222" },
    } as never);

    await updateCustomerForUser(5, 30, {
      capturedFieldUpdates: {
        customerPhone: "0100 111 2222",
      },
    });

    expect(mockedPrisma.customer.update).toHaveBeenCalledWith({
      where: { id: 30 },
      data: expect.objectContaining({
        phone: "0100 111 2222",
        normalizedPhone: "01001112222",
        capturedFields: { customerPhone: "0100 111 2222" },
      }),
    });
  });

  it("clears captured fields when the last saved detail is deleted", async () => {
    const baseCustomer = {
      id: 31,
      businessProfileId: 1,
      displayName: "Mona",
      phone: null,
      email: null,
      avatarUrl: null,
      primaryChannel: "web",
      status: "ACTIVE",
      notes: null,
      capturedFields: { interest: "pricing" },
      externalIdentities: [],
      lastInteractionAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      businessProfile: {
        id: 1,
        name: "Wkil",
        customerMemoryFields: [],
      },
      conversations: [],
      _count: { conversations: 0 },
    };
    mockedPrisma.customer.findFirst
      .mockResolvedValueOnce(baseCustomer as never)
      .mockResolvedValueOnce({
        ...baseCustomer,
        capturedFields: {},
      } as never);
    mockedPrisma.customer.update.mockResolvedValue({
      ...baseCustomer,
      capturedFields: {},
    } as never);

    await updateCustomerForUser(5, 31, {
      capturedFieldUpdates: {
        interest: null,
      },
    });

    expect(mockedPrisma.customer.update).toHaveBeenCalledWith({
      where: { id: 31 },
      data: expect.objectContaining({
        capturedFields: null,
      }),
    });
  });

  it("writes resolvedAt when the customer is moved to RESOLVED", async () => {
    const baseCustomer = {
      id: 40,
      businessProfileId: 1,
      displayName: "Layla",
      phone: null,
      email: null,
      avatarUrl: null,
      primaryChannel: "web",
      status: "ACTIVE",
      resolvedAt: null,
      notes: null,
      capturedFields: {},
      externalIdentities: [],
      lastInteractionAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      businessProfile: {
        id: 1,
        name: "Wkil",
        customerMemoryFields: [],
      },
      conversations: [],
      _count: { conversations: 0 },
    };
    mockedPrisma.customer.findFirst
      .mockResolvedValueOnce(baseCustomer as never)
      .mockResolvedValueOnce({
        ...baseCustomer,
        status: "RESOLVED",
        resolvedAt: new Date("2026-06-27T12:00:00Z"),
      } as never);
    mockedPrisma.customer.update.mockResolvedValue({
      ...baseCustomer,
      status: "RESOLVED",
      resolvedAt: new Date("2026-06-27T12:00:00Z"),
    } as never);

    await updateCustomerForUser(5, 40, { status: "RESOLVED" });

    expect(mockedPrisma.customer.update).toHaveBeenCalledWith({
      where: { id: 40 },
      data: expect.objectContaining({
        status: "RESOLVED",
        resolvedAt: expect.any(Date),
        resolvedByUserId: 5,
      }),
    });
  });

  it("clears resolvedAt when the customer leaves RESOLVED", async () => {
    const baseCustomer = {
      id: 41,
      businessProfileId: 1,
      displayName: "Layla",
      phone: null,
      email: null,
      avatarUrl: null,
      primaryChannel: "web",
      status: "RESOLVED",
      resolvedAt: new Date("2026-06-27T12:00:00Z"),
      notes: null,
      capturedFields: {},
      externalIdentities: [],
      lastInteractionAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      businessProfile: {
        id: 1,
        name: "Wkil",
        customerMemoryFields: [],
      },
      conversations: [],
      _count: { conversations: 0 },
    };
    mockedPrisma.customer.findFirst
      .mockResolvedValueOnce(baseCustomer as never)
      .mockResolvedValueOnce({
        ...baseCustomer,
        status: "ACTIVE",
        resolvedAt: null,
      } as never);
    mockedPrisma.customer.update.mockResolvedValue({
      ...baseCustomer,
      status: "ACTIVE",
      resolvedAt: null,
    } as never);

    await updateCustomerForUser(5, 41, { status: "ACTIVE" });

    expect(mockedPrisma.customer.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: expect.objectContaining({
        status: "ACTIVE",
        resolvedAt: null,
        resolvedByUserId: null,
      }),
    });
  });

  it("reconciles a customer to RESOLVED when every conversation is RESOLVED", async () => {
    const baseCustomer = {
      id: 50,
      businessProfileId: 1,
      displayName: "Hala",
      phone: null,
      email: null,
      avatarUrl: null,
      primaryChannel: "web",
      status: "ACTIVE",
      resolvedAt: null,
      notes: null,
      capturedFields: {},
      externalIdentities: [],
      lastInteractionAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      businessProfile: {
        id: 1,
        name: "Wkil",
        customerMemoryFields: [],
      },
      conversations: [
        { id: 10, status: "RESOLVED" },
        { id: 11, status: "RESOLVED" },
      ],
      _count: { conversations: 2 },
    };
    const updatedCustomer = {
      ...baseCustomer,
      status: "RESOLVED",
      resolvedAt: new Date(),
    };
    mockedPrisma.customer.findFirst
      .mockResolvedValueOnce(baseCustomer as never) // reconcile -> getCustomerForUser
      .mockResolvedValueOnce(baseCustomer as never) // setCustomerStatus -> getCustomerForUser (check current)
      .mockResolvedValueOnce(updatedCustomer as never); // setCustomerStatus -> getCustomerForUser (re-fetch after update)
    mockedPrisma.customer.update.mockResolvedValue({} as never);

    const result = await reconcileCustomerStatusFromConversations(5, 50);

    expect(mockedPrisma.customer.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: expect.objectContaining({
        status: "RESOLVED",
        resolvedAt: expect.any(Date),
        resolvedByUserId: 5,
      }),
    });
    expect(result).not.toBeNull();
  });

  it("reconciles a RESOLVED customer back to ACTIVE when a conversation reopens", async () => {
    const baseCustomer = {
      id: 51,
      businessProfileId: 1,
      displayName: "Hala",
      phone: null,
      email: null,
      avatarUrl: null,
      primaryChannel: "web",
      status: "RESOLVED",
      resolvedAt: new Date(),
      notes: null,
      capturedFields: {},
      externalIdentities: [],
      lastInteractionAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      businessProfile: {
        id: 1,
        name: "Wkil",
        customerMemoryFields: [],
      },
      conversations: [
        { id: 10, status: "RESOLVED" },
        { id: 11, status: "OPEN" },
      ],
      _count: { conversations: 2 },
    };
    const updatedCustomer = {
      ...baseCustomer,
      status: "ACTIVE",
      resolvedAt: null,
    };
    mockedPrisma.customer.findFirst
      .mockResolvedValueOnce(baseCustomer as never) // reconcile -> getCustomerForUser
      .mockResolvedValueOnce(baseCustomer as never) // setCustomerStatus -> getCustomerForUser (check current)
      .mockResolvedValueOnce(updatedCustomer as never); // setCustomerStatus -> getCustomerForUser (re-fetch after update)
    mockedPrisma.customer.update.mockResolvedValue({} as never);

    await reconcileCustomerStatusFromConversations(5, 51);

    expect(mockedPrisma.customer.update).toHaveBeenCalledWith({
      where: { id: 51 },
      data: expect.objectContaining({
        status: "ACTIVE",
        resolvedAt: null,
        resolvedByUserId: null,
      }),
    });
  });

  it("does not reconcile when the feature flag is off", async () => {
    const original = process.env.CUSTOMER_STATUS_AUTO_FROM_CONVERSATIONS;
    process.env.CUSTOMER_STATUS_AUTO_FROM_CONVERSATIONS = "false";
    try {
      const result = await reconcileCustomerStatusFromConversations(5, 99);
      expect(result).toBeNull();
      expect(mockedPrisma.customer.findFirst).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) {
        delete process.env.CUSTOMER_STATUS_AUTO_FROM_CONVERSATIONS;
      } else {
        process.env.CUSTOMER_STATUS_AUTO_FROM_CONVERSATIONS = original;
      }
    }
  });

  it("keeps the customer ACTIVE when some conversations are still open", async () => {
    const baseCustomer = {
      id: 52,
      businessProfileId: 1,
      displayName: "Hala",
      phone: null,
      email: null,
      avatarUrl: null,
      primaryChannel: "web",
      status: "ACTIVE",
      resolvedAt: null,
      notes: null,
      capturedFields: {},
      externalIdentities: [],
      lastInteractionAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      businessProfile: {
        id: 1,
        name: "Wkil",
        customerMemoryFields: [],
      },
      conversations: [
        { id: 10, status: "RESOLVED" },
        { id: 11, status: "OPEN" },
      ],
      _count: { conversations: 2 },
    };
    mockedPrisma.customer.findFirst.mockResolvedValue(baseCustomer as never);

    const result = await reconcileCustomerStatusFromConversations(5, 52);

    // Aggregate is ACTIVE (one open conversation) and the customer is
    // already ACTIVE — no change.
    expect(result).toBeNull();
    expect(mockedPrisma.customer.update).not.toHaveBeenCalled();
  });

  it("preserves a manual NEEDS_FOLLOW_UP even when all conversations are RESOLVED", async () => {
    const baseCustomer = {
      id: 54,
      businessProfileId: 1,
      displayName: "Hala",
      phone: null,
      email: null,
      avatarUrl: null,
      primaryChannel: "web",
      status: "NEEDS_FOLLOW_UP",
      resolvedAt: null,
      notes: null,
      capturedFields: {},
      externalIdentities: [],
      lastInteractionAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      businessProfile: {
        id: 1,
        name: "Wkil",
        customerMemoryFields: [],
      },
      conversations: [
        { id: 10, status: "RESOLVED" },
        { id: 11, status: "RESOLVED" },
      ],
      _count: { conversations: 2 },
    };
    mockedPrisma.customer.findFirst.mockResolvedValue(baseCustomer as never);

    const result = await reconcileCustomerStatusFromConversations(5, 54);

    // Aggregate would be RESOLVED, but the customer was manually set
    // to NEEDS_FOLLOW_UP — manual state wins.
    expect(result).toBeNull();
    expect(mockedPrisma.customer.update).not.toHaveBeenCalled();
  });

  it("preserves a manual ARCHIVED even when a conversation reopens", async () => {
    const baseCustomer = {
      id: 55,
      businessProfileId: 1,
      displayName: "Hala",
      phone: null,
      email: null,
      avatarUrl: null,
      primaryChannel: "web",
      status: "ARCHIVED",
      resolvedAt: null,
      notes: null,
      capturedFields: {},
      externalIdentities: [],
      lastInteractionAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      businessProfile: {
        id: 1,
        name: "Wkil",
        customerMemoryFields: [],
      },
      conversations: [{ id: 10, status: "OPEN" }],
      _count: { conversations: 1 },
    };
    mockedPrisma.customer.findFirst.mockResolvedValue(baseCustomer as never);

    const result = await reconcileCustomerStatusFromConversations(5, 55);

    // Aggregate would be ACTIVE, but the customer is ARCHIVED — manual
    // state wins.
    expect(result).toBeNull();
    expect(mockedPrisma.customer.update).not.toHaveBeenCalled();
  });

  it("setCustomerStatus is a no-op when the new status matches the current one", async () => {
    const baseCustomer = {
      id: 53,
      businessProfileId: 1,
      displayName: "Hala",
      phone: null,
      email: null,
      avatarUrl: null,
      primaryChannel: "web",
      status: "ACTIVE",
      resolvedAt: null,
      notes: null,
      capturedFields: {},
      externalIdentities: [],
      lastInteractionAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      businessProfile: {
        id: 1,
        name: "Wkil",
        customerMemoryFields: [],
      },
      conversations: [],
      _count: { conversations: 0 },
    };
    mockedPrisma.customer.findFirst.mockResolvedValue(baseCustomer as never);

    const result = await setCustomerStatus(5, 53, "ACTIVE");

    expect(mockedPrisma.customer.update).not.toHaveBeenCalled();
    expect(result.status).toBe("ACTIVE");
  });

  it("bulk-resolves all conversations when the customer flips to RESOLVED", async () => {
    const baseCustomer = {
      id: 60,
      businessProfileId: 1,
      displayName: "Hala",
      phone: null,
      email: null,
      avatarUrl: null,
      primaryChannel: "web",
      status: "ACTIVE",
      resolvedAt: null,
      notes: null,
      capturedFields: {},
      externalIdentities: [],
      lastInteractionAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      businessProfile: {
        id: 1,
        name: "Wkil",
        customerMemoryFields: [],
      },
      conversations: [
        { id: 1, status: "OPEN" },
        { id: 2, status: "RESOLVED" },
        { id: 3, status: "ARCHIVED" },
      ],
      _count: { conversations: 3 },
    };
    mockedPrisma.customer.findFirst
      .mockResolvedValueOnce(baseCustomer as never) // setCustomerStatus -> getCustomerForUser
      .mockResolvedValueOnce({
        ...baseCustomer,
        status: "RESOLVED",
        resolvedAt: new Date(),
      } as never);
    mockedPrisma.customer.update.mockResolvedValue({} as never);
    mockedPrisma.conversation.updateMany.mockResolvedValue({ count: 2 } as never);

    await setCustomerStatus(5, 60, "RESOLVED");

    // OPEN and RESOLVED conversations both flip to RESOLVED; ARCHIVED
    // is left alone.
    expect(mockedPrisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { customerId: 60, status: { not: "ARCHIVED" } },
      data: { status: "RESOLVED" },
    });
  });

  it("bulk-reopens all RESOLVED conversations when the customer flips to ACTIVE", async () => {
    const baseCustomer = {
      id: 61,
      businessProfileId: 1,
      displayName: "Hala",
      phone: null,
      email: null,
      avatarUrl: null,
      primaryChannel: "web",
      status: "RESOLVED",
      resolvedAt: new Date(),
      notes: null,
      capturedFields: {},
      externalIdentities: [],
      lastInteractionAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      businessProfile: {
        id: 1,
        name: "Wkil",
        customerMemoryFields: [],
      },
      conversations: [
        { id: 1, status: "RESOLVED" },
        { id: 2, status: "ARCHIVED" },
      ],
      _count: { conversations: 2 },
    };
    mockedPrisma.customer.findFirst
      .mockResolvedValueOnce(baseCustomer as never)
      .mockResolvedValueOnce({
        ...baseCustomer,
        status: "ACTIVE",
        resolvedAt: null,
      } as never);
    mockedPrisma.customer.update.mockResolvedValue({} as never);
    mockedPrisma.conversation.updateMany.mockResolvedValue({ count: 1 } as never);

    await setCustomerStatus(5, 61, "ACTIVE");

    // Only RESOLVED conversations reopen; ARCHIVED is left alone.
    expect(mockedPrisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { customerId: 61, status: "RESOLVED" },
      data: { status: "OPEN" },
    });
  });

  it("does not touch conversations when the customer flips to a manual state", async () => {
    const baseCustomer = {
      id: 62,
      businessProfileId: 1,
      displayName: "Hala",
      phone: null,
      email: null,
      avatarUrl: null,
      primaryChannel: "web",
      status: "ACTIVE",
      resolvedAt: null,
      notes: null,
      capturedFields: {},
      externalIdentities: [],
      lastInteractionAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      businessProfile: {
        id: 1,
        name: "Wkil",
        customerMemoryFields: [],
      },
      conversations: [
        { id: 1, status: "OPEN" },
        { id: 2, status: "RESOLVED" },
      ],
      _count: { conversations: 2 },
    };
    mockedPrisma.customer.findFirst
      .mockResolvedValueOnce(baseCustomer as never)
      .mockResolvedValueOnce({
        ...baseCustomer,
        status: "NEEDS_FOLLOW_UP",
      } as never);
    mockedPrisma.customer.update.mockResolvedValue({} as never);

    await setCustomerStatus(5, 62, "NEEDS_FOLLOW_UP");

    expect(mockedPrisma.conversation.updateMany).not.toHaveBeenCalled();
  });
});
