import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@config/prisma", () => ({
  default: {
    $transaction: vi.fn().mockRejectedValue(Object.assign(new Error("duplicate reservation"), { code: "P2002" })),
    agentModelReservation: { create: vi.fn(), deleteMany: vi.fn() },
    aiCallLog: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("@modules/billing/billing.service", () => ({
  calculateCustomerCost: vi.fn().mockResolvedValue({ customerCost: 0.001 }),
}));
vi.mock("@modules/workspace/workspace.service", () => ({
  requireWorkspaceProfileAccess: vi.fn().mockResolvedValue(undefined),
}));

import prisma from "@config/prisma";
import router from "./agent.model-reservation";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/model-calls", router);
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe("legacy model-call compatibility routes", () => {
  it("admits a valid call even when an unresolved user reservation exists", async () => {
    const response = await request(makeApp()).post("/model-calls/reserve").send({
      eventId: "run-2", userId: 7, businessProfileId: 3,
      modelName: "test-model", promptTokens: 10, completionTokens: 100,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, reservedCredits: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.agentModelReservation.create).not.toHaveBeenCalled();
  });

  it("acknowledges legacy release without checking usage or deleting historical rows", async () => {
    const response = await request(makeApp()).post("/model-calls/release").send({
      userId: 7, eventId: "run-2",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(prisma.aiCallLog.findUnique).not.toHaveBeenCalled();
    expect(prisma.agentModelReservation.deleteMany).not.toHaveBeenCalled();
  });

  it("still rejects malformed compatibility payloads", async () => {
    const reserve = await request(makeApp()).post("/model-calls/reserve").send({ userId: 7 });
    const release = await request(makeApp()).post("/model-calls/release").send({ userId: 7 });

    expect(reserve.status).toBe(400);
    expect(release.status).toBe(400);
  });
});
