import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const records = new Map<string, any>();
vi.mock("@config/prisma", () => ({ default: { agentOperation: {
  create: vi.fn(async ({ data }) => {
    if (records.has(data.id)) throw Object.assign(new Error("duplicate"), { code: "P2002" });
    const record = { ...data, status: "PENDING" }; records.set(data.id, record); return record;
  }),
  findUnique: vi.fn(async ({ where }) => records.get(where.id)),
  update: vi.fn(async ({ where, data }) => { Object.assign(records.get(where.id), data); }),
} } }));

import { durableAgentOperation } from "./agent.operation";

beforeEach(() => records.clear());

function setup() {
  const effect = vi.fn();
  const app = express(); app.use(express.json()); app.use(durableAgentOperation);
  app.post("/send", (_req, res) => { effect(); res.json({ externalId: "sent-1" }); });
  app.post("/onboarding/analyze", (_req, res) => { effect(); res.json({ draft: true }); });
  return { app, effect };
}

describe("durable agent effects", () => {
  it("returns the recorded outcome on retry without invoking the provider twice", async () => {
    const { app, effect } = setup();
    const invoke = () => request(app).post("/send").set("x-agent-operation-id", "thread-a-call-a").send({ userId: 3, businessProfileId: 5, text: "hello" });
    expect((await invoke()).body).toEqual({ externalId: "sent-1" });
    expect((await invoke()).body).toEqual({ externalId: "sent-1" });
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("refuses an ambiguous pending operation after a process crash", async () => {
    const { app, effect } = setup();
    await request(app).post("/send").set("x-agent-operation-id", "pending").send({ userId: 3, text: "hello" });
    for (const row of records.values()) row.status = "PENDING";
    const res = await request(app).post("/send").set("x-agent-operation-id", "pending").send({ userId: 3, text: "hello" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("operation_requires_reconciliation");
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("rejects reusing an operation ID for different content", async () => {
    const { app, effect } = setup();
    await request(app).post("/send").set("x-agent-operation-id", "same").send({ userId: 3, text: "hello" });
    const res = await request(app).post("/send").set("x-agent-operation-id", "same").send({ userId: 3, text: "different" });
    expect(res.status).toBe(409);
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("requires a stable operation ID before writes", async () => {
    const { app, effect } = setup();
    expect((await request(app).post("/send").send({ userId: 3 })).status).toBe(400);
    expect(effect).not.toHaveBeenCalled();
  });

  it("does not claim an idempotency operation for read-only onboarding analysis", async () => {
    const { app, effect } = setup();
    const res = await request(app).post("/onboarding/analyze").send({ userId: 3 });
    expect(res.status).toBe(200);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(records.size).toBe(0);
  });

  it("binds nested legacy tool scope into the durable operation identity", async () => {
    const { app, effect } = setup();
    const send = () => request(app).post("/send")
      .set("x-agent-operation-id", "nested-scope")
      .send({ userId: 3, args: { businessProfileId: 5 }, text: "hello" });
    await send();
    await send();
    expect(effect).toHaveBeenCalledTimes(1);
    expect([...records.values()][0].businessProfileId).toBe(5);
  });
});
