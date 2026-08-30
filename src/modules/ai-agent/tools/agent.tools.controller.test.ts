import request from "supertest";
import express from "express";
import { describe, it, expect, vi } from "vitest";
import router from "./agent.tools.controller";

vi.mock("./copilot.actions.service", () => ({
  listCopilotConversations: vi.fn(),
  getCopilotConversationMessages: vi.fn(),
  listCopilotCustomers: vi.fn(),
}));
import {
  listCopilotConversations,
  getCopilotConversationMessages,
  listCopilotCustomers,
} from "./copilot.actions.service";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/internal/agent", router);
  return app;
}

describe("agent tools controller", () => {
  it("rejects missing service token", async () => {
    const app = makeApp();
    const res = await request(app).post("/internal/agent/tools/run")
      .send({ tool: "integration_action_1", tool_call_id: "c1", args: {} });
    expect(res.status).toBe(401);
  });
  it("rejects unknown tool with valid token", async () => {
    process.env.MONOLITH_SERVICE_TOKEN = "test-token";
    const app = makeApp();
    const res = await request(app).post("/internal/agent/tools/run")
      .set("x-service-token", "test-token")
      .send({ tool: "noop", tool_call_id: "c1", args: {} });
    expect(res.status).toBe(400);
  });
});

it("GET /copilot/conversations requires userId", async () => {
  const app = makeApp();
  const res = await request(app).get("/internal/agent/copilot/conversations").set("x-service-token", "test-token");
  expect(res.status).toBe(400);
});

it("GET /copilot/conversations returns envelopes", async () => {
  vi.mocked(listCopilotConversations).mockResolvedValue({ conversations: [], envelopes: [] } as any);
  const app = makeApp();
  const res = await request(app).get("/internal/agent/copilot/conversations?userId=7").set("x-service-token", "test-token");
  expect(res.status).toBe(200);
  expect(res.body.envelopes).toEqual([]);
});
