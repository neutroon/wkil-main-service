import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  countStableCoexistenceContacts,
  syncCoexistenceContacts,
  type CoexistenceContactsJob,
  type CoexistenceContactStateSync,
} from "./whatsappCoexistenceContacts.service";
import { upsertCustomerFromConversation } from "@modules/business/customer/customer.service";

vi.mock("@config/prisma", () => ({
  Prisma: { JsonNull: null },
  default: {
    customerExternalIdentity: {
      findUnique: vi.fn(),
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
    whatsAppAccount: {
      findFirst: vi.fn(),
    },
    whatsAppCoexistenceContactEvent: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
    conversation: {
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@middlewares/errorHandler.middleware", () => ({
  AppError: class AppError extends Error {},
}));

vi.mock("@modules/auth/user/user.service", () => ({
  getAccessibleProfileIds: vi.fn(),
}));

import prisma from "@config/prisma";

const mockedPrisma = prisma as any;

function makeCustomer(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    businessProfileId: 42,
    displayName: "Nour",
    phone: "+20100111222",
    normalizedPhone: "+20100111222",
    email: null,
    normalizedEmail: null,
    avatarUrl: null,
    primaryChannel: "whatsapp",
    externalIds: { whatsapp: ["20100111222"] },
    capturedFields: null,
    metadata: {},
    lastInteractionAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function contact(overrides: Partial<CoexistenceContactStateSync> = {}) {
  return {
    type: "contact",
    eventId: "state-event-1",
    action: "add" as const,
    externalId: "20100111222@wa",
    phone: "+20 100 111 222",
    name: "Nour",
    metadata: { source: "phonebook" },
    ...overrides,
  };
}

function job(contacts: CoexistenceContactStateSync[]): CoexistenceContactsJob {
  return {
    platform: "whatsapp",
    type: "whatsapp_coexistence_contacts",
    wabaId: "waba-1",
    phoneNumberId: "phone-number-id",
    stateSync: contacts,
  };
}

describe("WhatsApp Coexistence contact synchronization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.whatsAppAccount.findFirst.mockResolvedValue({ businessProfileId: 42 });
    mockedPrisma.$transaction.mockImplementation((callback: (tx: any) => Promise<unknown>) =>
      callback(mockedPrisma),
    );
    mockedPrisma.customerExternalIdentity.findUnique.mockResolvedValue(null);
    mockedPrisma.customerExternalIdentity.upsert.mockImplementation((args: any) =>
      Promise.resolve({
        id: 1,
        businessProfileId: args.create.businessProfileId,
        customerId: args.create.customerId,
        channel: args.create.channel,
        externalId: args.create.externalId,
      }),
    );
    mockedPrisma.customer.update.mockImplementation((args: any) =>
      Promise.resolve({ ...makeCustomer(), ...args.data }),
    );
  });

  it("counts unique recognized contact state-sync entries", () => {
    const input = job([
      contact(),
      contact(),
      { type: "message", action: "add", phone: "+20100111222" },
    ]);

    expect(countStableCoexistenceContacts(input)).toBe(1);
  });

  it("adds a contact using the normalized phone identity without touching interaction time", async () => {
    mockedPrisma.customer.findUnique.mockResolvedValue(null);
    mockedPrisma.customer.create.mockResolvedValue(makeCustomer());

    const result = await syncCoexistenceContacts(
      job([
        {
          type: "contact",
          action: "add",
          contact: {
            wa_id: "20100111222@wa",
            full_name: "Nour",
            phone_number: "+20 100 111 222",
          },
        },
      ]),
    );

    expect(result).toMatchObject({ processed: 1, added: 1, updated: 0, removed: 0 });
    expect(mockedPrisma.whatsAppAccount.findFirst).toHaveBeenCalledWith({
      where: {
        phoneNumberId: "phone-number-id",
        isActive: true,
        businessProfileId: { not: null },
      },
      select: { businessProfileId: true },
    });
    expect(mockedPrisma.customer.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        businessProfileId: 42,
        displayName: "Nour",
        phone: "+20 100 111 222",
        normalizedPhone: "+20100111222",
        primaryChannel: "whatsapp",
      }),
    });
    expect(mockedPrisma.customer.create.mock.calls[0][0].data).toHaveProperty(
      "lastInteractionAt",
      null,
    );
  });

  it("edits a contact by normalized phone and merges its metadata", async () => {
    const existing = makeCustomer({
      displayName: "Old name",
      externalIds: { messenger: ["psid-1"] },
      metadata: { existing: true },
      lastInteractionAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    mockedPrisma.customer.findUnique.mockResolvedValue(existing);

    const result = await syncCoexistenceContacts(
      job([
        contact({
          action: "edit",
          eventId: "state-event-edit",
          externalId: "20100111222@wa",
          name: "New name",
          metadata: { source: "updated", optedIn: true },
        }),
      ]),
    );

    expect(result).toMatchObject({ processed: 1, added: 0, updated: 1, removed: 0 });
    expect(mockedPrisma.customer.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: expect.objectContaining({
        displayName: "New name",
        normalizedPhone: "+20100111222",
        metadata: expect.objectContaining({
          existing: true,
          source: "updated",
          optedIn: true,
        }),
        externalIds: {
          messenger: ["psid-1"],
          whatsapp: ["20100111222@wa"],
        },
      }),
    });
    expect(mockedPrisma.customer.update.mock.calls[0][0].data).not.toHaveProperty(
      "lastInteractionAt",
    );
  });

  it("preserves existing external identities while attaching the Coexistence identity", async () => {
    const existing = makeCustomer({
      externalIds: { messenger: ["psid-1"], whatsapp: ["old-wa-id"] },
    });
    mockedPrisma.customer.findUnique.mockResolvedValue(existing);

    await syncCoexistenceContacts(job([contact({ action: "edit" })]));

    expect(mockedPrisma.customerExternalIdentity.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          customerId: 7,
          businessProfileId: 42,
          channel: "whatsapp",
          externalId: "20100111222@wa",
        }),
      }),
    );
    expect(mockedPrisma.customerExternalIdentity.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.customer.delete).not.toHaveBeenCalled();
  });

  it("marks a removed contact as a tombstone without deleting its customer or history", async () => {
    mockedPrisma.customer.findUnique.mockResolvedValue(makeCustomer());

    const result = await syncCoexistenceContacts(
      job([contact({ action: "remove", eventId: "state-event-remove" })]),
    );

    expect(result).toMatchObject({ processed: 1, added: 0, updated: 0, removed: 1 });
    expect(mockedPrisma.customer.delete).not.toHaveBeenCalled();
    expect(mockedPrisma.conversation.updateMany).not.toHaveBeenCalled();
    expect(mockedPrisma.customer.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          whatsappCoexistence: expect.objectContaining({
            removed: true,
            state: "REMOVED",
          }),
        }),
      }),
    });
  });

  it("clears a removed tombstone when the contact is added or edited again", async () => {
    mockedPrisma.customer.findUnique.mockResolvedValue(
      makeCustomer({
        metadata: {
          source: "phonebook",
          whatsappCoexistence: {
            state: "REMOVED",
            removed: true,
            removedAt: "2026-01-02T00:00:00.000Z",
            processedEventIds: ["event:old-remove"],
          },
        },
      }),
    );

    await syncCoexistenceContacts(
      job([
        contact({
          action: "edit",
          eventId: "state-event-restore",
          metadata: { source: "phonebook-updated" },
        }),
      ]),
    );

    const metadata = mockedPrisma.customer.update.mock.calls[0][0].data.metadata;
    expect(metadata).toMatchObject({
      source: "phonebook-updated",
      whatsappCoexistence: {},
    });
    expect(metadata.whatsappCoexistence).not.toHaveProperty("processedEventIds");
    expect(metadata.whatsappCoexistence).not.toHaveProperty("state");
    expect(metadata.whatsappCoexistence).not.toHaveProperty("removed");
    expect(metadata.whatsappCoexistence).not.toHaveProperty("removedAt");
  });

  it("processes a duplicated contact event once", async () => {
    mockedPrisma.customer.findUnique.mockResolvedValue(null);
    mockedPrisma.customer.create.mockResolvedValue(makeCustomer());

    const duplicate = contact({ eventId: "same-event" });
    const result = await syncCoexistenceContacts(job([duplicate, { ...duplicate, name: "Other" }]));

    expect(result).toMatchObject({ processed: 1, duplicates: 1, added: 1 });
    expect(mockedPrisma.customer.create).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.customer.update).not.toHaveBeenCalled();
  });

  it("does not repeat database side effects when the same queue job is delivered twice", async () => {
    const eventKeys = new Set<string>();
    let storedCustomer: any = null;
    mockedPrisma.whatsAppCoexistenceContactEvent.create.mockImplementation((args: any) => {
      const key = `${args.data.businessProfileId}:${args.data.phoneNumberId}:${args.data.eventKey}`;
      if (eventKeys.has(key)) {
        const error: any = new Error("duplicate event claim");
        error.code = "P2002";
        return Promise.reject(error);
      }
      eventKeys.add(key);
      return Promise.resolve({ id: 1, ...args.data });
    });
    mockedPrisma.customerExternalIdentity.findUnique.mockResolvedValue(null);
    mockedPrisma.customer.findUnique.mockImplementation(() => Promise.resolve(storedCustomer));
    mockedPrisma.customer.findFirst.mockImplementation(() =>
      Promise.resolve(
        storedCustomer
          ? { id: storedCustomer.id, metadata: storedCustomer.metadata }
          : null,
      ),
    );
    mockedPrisma.customer.create.mockImplementation((args: any) => {
      storedCustomer = { ...makeCustomer(), ...args.data, id: 7 };
      return Promise.resolve(storedCustomer);
    });
    mockedPrisma.customer.update.mockImplementation((args: any) => {
      storedCustomer = { ...storedCustomer, ...args.data };
      return Promise.resolve(storedCustomer);
    });

    const first = await syncCoexistenceContacts(job([contact({ eventId: "repeat-event" })]));
    const second = await syncCoexistenceContacts(job([contact({ eventId: "repeat-event" })]));

    expect(first).toMatchObject({ processed: 1, added: 1 });
    expect(second).toMatchObject({ processed: 0, duplicates: 1 });
    expect(mockedPrisma.customer.create).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.customer.update).not.toHaveBeenCalled();
    expect(mockedPrisma.customerExternalIdentity.upsert).toHaveBeenCalledTimes(1);
  });

  it("suppresses concurrent deliveries with an atomic durable event claim", async () => {
    const eventKeys = new Set<string>();
    let releaseFirstCreate!: () => void;
    let firstCreateStarted!: () => void;
    const firstCreateReady = new Promise<void>((resolve) => {
      firstCreateStarted = resolve;
    });
    const allowFirstCreate = new Promise<void>((resolve) => {
      releaseFirstCreate = resolve;
    });

    mockedPrisma.$transaction.mockImplementation((callback: (tx: any) => Promise<unknown>) =>
      callback(mockedPrisma),
    );
    mockedPrisma.whatsAppCoexistenceContactEvent.create.mockImplementation((args: any) => {
      const key = `${args.data.businessProfileId}:${args.data.phoneNumberId}:${args.data.eventKey}`;
      if (eventKeys.has(key)) {
        const error: any = new Error("duplicate event claim");
        error.code = "P2002";
        return Promise.reject(error);
      }
      eventKeys.add(key);
      return Promise.resolve({ id: 1, ...args.data });
    });
    mockedPrisma.customer.findUnique.mockResolvedValue(null);
    let createCalls = 0;
    mockedPrisma.customer.create.mockImplementation(async () => {
      createCalls += 1;
      if (createCalls === 1) {
        firstCreateStarted();
        await allowFirstCreate;
      }
      return makeCustomer();
    });

    const first = syncCoexistenceContacts(job([contact({ eventId: "concurrent-event" })]));
    await firstCreateReady;
    const second = await syncCoexistenceContacts(job([contact({ eventId: "concurrent-event" })]));

    expect(second).toMatchObject({ processed: 0, duplicates: 1 });
    releaseFirstCreate();
    await expect(first).resolves.toMatchObject({ processed: 1, added: 1 });
    expect(mockedPrisma.customer.create).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.whatsAppCoexistenceContactEvent.create).toHaveBeenCalledTimes(2);
  });

  it("rolls back an event claim when customer persistence fails so retry can finish", async () => {
    const eventKeys = new Set<string>();
    mockedPrisma.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => {
      const before = new Set(eventKeys);
      try {
        return await callback(mockedPrisma);
      } catch (error) {
        eventKeys.clear();
        for (const key of before) eventKeys.add(key);
        throw error;
      }
    });
    mockedPrisma.whatsAppCoexistenceContactEvent.create.mockImplementation((args: any) => {
      const key = `${args.data.businessProfileId}:${args.data.phoneNumberId}:${args.data.eventKey}`;
      if (eventKeys.has(key)) {
        const error: any = new Error("duplicate event claim");
        error.code = "P2002";
        return Promise.reject(error);
      }
      eventKeys.add(key);
      return Promise.resolve({ id: 1, ...args.data });
    });
    mockedPrisma.customer.findUnique.mockResolvedValue(makeCustomer());
    mockedPrisma.customer.update
      .mockRejectedValueOnce(new Error("customer update failed"))
      .mockResolvedValue(makeCustomer());

    await expect(
      syncCoexistenceContacts(job([contact({ eventId: "retry-event", action: "edit" })])),
    ).rejects.toThrow("customer update failed");

    const retry = await syncCoexistenceContacts(
      job([contact({ eventId: "retry-event", action: "edit" })]),
    );

    expect(retry).toMatchObject({ processed: 1, updated: 1 });
    expect(mockedPrisma.whatsAppCoexistenceContactEvent.create).toHaveBeenCalledTimes(2);
    expect(mockedPrisma.customer.update).toHaveBeenCalledTimes(2);
  });

  it("keeps live current-time interaction updates and allows Coexistence callers to opt out", async () => {
    const existing = makeCustomer({ lastInteractionAt: new Date("2026-01-01T00:00:00.000Z") });
    mockedPrisma.customer.findUnique.mockResolvedValue(existing);

    await upsertCustomerFromConversation({
      businessProfileId: 42,
      channel: "whatsapp",
      senderId: "20100111222@wa",
      customerPhone: "+20100111222",
      customerName: "Nour",
    });

    const liveData = mockedPrisma.customer.update.mock.calls[0][0].data;
    expect(liveData.lastInteractionAt).toBeInstanceOf(Date);
    expect(liveData.lastInteractionAt.getTime()).toBeGreaterThan(new Date("2026-01-01").getTime());

    mockedPrisma.customer.update.mockClear();
    await upsertCustomerFromConversation({
      businessProfileId: 42,
      channel: "whatsapp",
      senderId: "20100111222@wa",
      customerPhone: "+20100111222",
      customerName: "Nour",
      updateInteraction: false,
    });

    expect(mockedPrisma.customer.update.mock.calls[0][0].data).not.toHaveProperty(
      "lastInteractionAt",
    );
  });

  it("uses a historical activity timestamp without regressing newer live activity", async () => {
    const activityAt = new Date("2026-03-01T00:00:00.000Z");
    mockedPrisma.customer.findUnique.mockResolvedValue(
      makeCustomer({ lastInteractionAt: new Date("2026-01-01T00:00:00.000Z") }),
    );

    await upsertCustomerFromConversation({
      businessProfileId: 42,
      channel: "whatsapp",
      senderId: "20100111222@wa",
      customerPhone: "+20100111222",
      customerName: "Nour",
      updateInteraction: false,
      activityAt,
    });

    expect(mockedPrisma.customer.update.mock.calls[0][0].data.lastInteractionAt).toEqual(activityAt);

    mockedPrisma.customer.update.mockClear();
    mockedPrisma.customer.findUnique.mockResolvedValue(
      makeCustomer({ lastInteractionAt: new Date("2026-04-01T00:00:00.000Z") }),
    );

    await upsertCustomerFromConversation({
      businessProfileId: 42,
      channel: "whatsapp",
      senderId: "20100111222@wa",
      customerPhone: "+20100111222",
      customerName: "Nour",
      updateInteraction: false,
      activityAt,
    });

    expect(mockedPrisma.customer.update.mock.calls[0][0].data).not.toHaveProperty(
      "lastInteractionAt",
    );
  });
});
