import request from "supertest";
import express from "express";
import { describe, it, expect, vi } from "vitest";
import router from "./agent.tools.controller";

vi.mock("./copilot.actions.service", () => ({
  listCopilotConversations: vi.fn(),
  getCopilotConversationMessages: vi.fn(),
  listCopilotCustomers: vi.fn(),
  getAgentSettingsForUser: vi.fn(),
  updateAgentSettings: vi.fn(),
  listCopilotKnowledge: vi.fn(),
  createCopilotKnowledge: vi.fn(),
  updateCopilotKnowledge: vi.fn(),
  deleteCopilotKnowledge: vi.fn(),
}));
import {
  listCopilotConversations,
  getCopilotConversationMessages,
  listCopilotCustomers,
  getAgentSettingsForUser,
  listCopilotKnowledge,
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

it("GET /copilot/agent-settings returns settings", async () => {
  vi.mocked(getAgentSettingsForUser).mockResolvedValue({
    settings: { name: "Acme", voice: "Friendly", tone: "Calm", handoffEnabled: true, corePolicies: null, aiBehaviorInstructions: null },
  } as any);
  const app = makeApp();
  const res = await request(app).get("/internal/agent/copilot/agent-settings?userId=7").set("x-service-token", "test-token");
  expect(res.status).toBe(200);
  expect(res.body.settings).toMatchObject({ name: "Acme" });
  expect(getAgentSettingsForUser).toHaveBeenCalledWith({ userId: 7, businessProfileId: undefined });
});

it("GET /copilot/knowledge delegates to listCopilotKnowledge", async () => {
  vi.mocked(listCopilotKnowledge).mockResolvedValue({ documents: [], envelopes: [] } as any);
  const app = makeApp();
  const res = await request(app).get("/internal/agent/copilot/knowledge?userId=7&kind=faq&limit=5").set("x-service-token", "test-token");
  expect(res.status).toBe(200);
  expect(res.body.envelopes).toEqual([]);
  expect(listCopilotKnowledge).toHaveBeenCalledWith({ userId: 7, businessProfileId: undefined, kind: "faq", q: undefined, limit: 5 });
});
