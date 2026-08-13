import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@config/prisma", () => ({
  default: {
    orderIntegration: {
      findFirst: mocks.findFirst,
    },
    orderEvent: {
      create: mocks.create,
    },
  },
}));

import {
  findActiveIntegrationByPublicKey,
  insertOrderEventIfNew,
} from "./orderConfirmation.repository";

const eventParams = {
  integrationId: 7,
  businessProfileId: 11,
  externalEventId: "evt_123",
  eventType: "order.created",
  schemaVersion: "1",
  occurredAt: new Date("2026-08-13T10:30:00.000Z"),
  rawPayload: {
    schemaVersion: "1",
    eventId: "evt_123",
    eventType: "order.created",
    occurredAt: "2026-08-13T10:30:00.000Z",
    order: {
      id: "ord_123",
      number: "#123",
      currency: "USD",
      total: "10.00",
      customer: { phone: "+12025550123" },
    },
  },
} as const;

describe("order confirmation repository", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects only verification fields for an active integration", async () => {
    const integration = {
      id: 7,
      businessProfileId: 11,
      signingSecret: "enc:v1:encrypted-secret",
      isActive: true,
    };
    mocks.findFirst.mockResolvedValue(integration);

    await expect(findActiveIntegrationByPublicKey("public-key")).resolves.toEqual(
      integration,
    );

    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { integrationKey: "public-key", isActive: true },
      select: {
        id: true,
        businessProfileId: true,
        signingSecret: true,
        isActive: true,
      },
    });
  });

  it("persists a received immutable event without returning secrets", async () => {
    const created = { id: 101, ...eventParams };
    mocks.create.mockResolvedValue(created);

    const result = await insertOrderEventIfNew(eventParams);

    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        integrationId: 7,
        businessProfileId: 11,
        externalEventId: "evt_123",
        eventType: "order.created",
        schemaVersion: "1",
        occurredAt: eventParams.occurredAt,
        rawPayload: eventParams.rawPayload,
        status: "RECEIVED",
      },
    });
    expect(result).toEqual({ duplicate: false, event: { id: 101 } });
    expect(result).not.toHaveProperty("signingSecret");
    expect(JSON.stringify(result)).not.toContain("enc:v1:");
  });

  it("returns a duplicate result for the event composite unique conflict", async () => {
    mocks.create.mockRejectedValue({ code: "P2002", meta: { target: ["integrationId", "externalEventId"] } });

    await expect(insertOrderEventIfNew(eventParams)).resolves.toEqual({
      duplicate: true,
    });
  });
});
