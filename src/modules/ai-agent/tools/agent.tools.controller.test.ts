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
  copilotListContentPlans: vi.fn(),
  copilotGetContentPlan: vi.fn(),
  copilotGenerateContentPlan: vi.fn(),
  copilotGeneratePostContent: vi.fn(),
  copilotApproveContentPost: vi.fn(),
  copilotDeleteContentPlan: vi.fn(),
}));
import {
  listCopilotConversations,
  getCopilotConversationMessages,
  listCopilotCustomers,
  getAgentSettingsForUser,
  listCopilotKnowledge,
  copilotListContentPlans,
  copilotGetContentPlan,
  copilotGenerateContentPlan,
  copilotGeneratePostContent,
  copilotApproveContentPost,
  copilotDeleteContentPlan,
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

// --- copilot content tools ---

it("GET /copilot/content/plans delegates to copilotListContentPlans", async () => {
  vi.mocked(copilotListContentPlans).mockResolvedValue({ plans: [{ id: 1 }], meta: { total: 1, limit: 5 } } as any);
  const app = makeApp();
  const res = await request(app).get("/internal/agent/copilot/content/plans?userId=7&limit=5").set("x-service-token", "test-token");
  expect(res.status).toBe(200);
  expect(res.body.plans).toHaveLength(1);
  expect(copilotListContentPlans).toHaveBeenCalledWith({ userId: 7, businessProfileId: undefined, status: undefined, limit: 5 });
});

it("GET /copilot/content/plans/:id returns the plan for the owner", async () => {
  vi.mocked(copilotGetContentPlan).mockResolvedValue({ id: 3, posts: [] } as any);
  const app = makeApp();
  const res = await request(app).get("/internal/agent/copilot/content/plans/3?userId=7").set("x-service-token", "test-token");
  expect(res.status).toBe(200);
  expect(res.body.id).toBe(3);
  expect(copilotGetContentPlan).toHaveBeenCalledWith({ userId: 7, planId: 3 });
});

it("GET /copilot/content/plans/:id rejects foreign plans", async () => {
  vi.mocked(copilotGetContentPlan).mockRejectedValue(new Error("Content plan not found"));
  const app = makeApp();
  const res = await request(app).get("/internal/agent/copilot/content/plans/999?userId=7").set("x-service-token", "test-token");
  expect(res.status).toBe(404);
});

it("POST /copilot/content/plans/generate delegates the draft", async () => {
  vi.mocked(copilotGenerateContentPlan).mockResolvedValue({ planId: 11, envelopes: [{ type: "content-plan" }] } as any);
  const app = makeApp();
  const res = await request(app).post("/internal/agent/copilot/content/plans/generate").set("x-service-token", "test-token")
    .send({ userId: 7, businessProfileId: 1, goal: "g", platform: "facebook", draft: { posts: [{ scheduled_at: "2026-09-07", topic: "t" }] } });
  expect(res.status).toBe(200);
  expect(res.body.planId).toBe(11);
  expect(copilotGenerateContentPlan).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, businessProfileId: 1, goal: "g", platform: "facebook" }));
});

it("POST /copilot/content/plans/generate rejects an empty draft", async () => {
  const app = makeApp();
  const res = await request(app).post("/internal/agent/copilot/content/plans/generate").set("x-service-token", "test-token")
    .send({ userId: 7, businessProfileId: 1, draft: { posts: [] } });
  expect(res.status).toBe(400);
});

it("POST /copilot/content/posts/:id/generate persists generated content", async () => {
  vi.mocked(copilotGeneratePostContent).mockResolvedValue({ ok: true, post: { id: 5, status: "generated" } } as any);
  const app = makeApp();
  const res = await request(app).post("/internal/agent/copilot/content/posts/5/generate").set("x-service-token", "test-token")
    .send({ userId: 7, caption: "c", imagePrompt: "i" });
  expect(res.status).toBe(200);
  expect(res.body.post.status).toBe("generated");
  expect(copilotGeneratePostContent).toHaveBeenCalledWith({ userId: 7, postId: 5, caption: "c", imagePrompt: "i" });
});

it("POST /copilot/content/posts/:id/approve delegates ownership-checked approve", async () => {
  vi.mocked(copilotApproveContentPost).mockResolvedValue({ ok: true, post: { id: 5, status: "approved" } } as any);
  const app = makeApp();
  const res = await request(app).post("/internal/agent/copilot/content/posts/5/approve").set("x-service-token", "test-token")
    .send({ userId: 7 });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(copilotApproveContentPost).toHaveBeenCalledWith({ userId: 7, postId: 5 });
});

it("POST /copilot/content/posts/:id/approve rejects foreign posts", async () => {
  vi.mocked(copilotApproveContentPost).mockRejectedValue(new Error("Unauthorized or post not found"));
  const app = makeApp();
  const res = await request(app).post("/internal/agent/copilot/content/posts/999/approve").set("x-service-token", "test-token")
    .send({ userId: 7 });
  expect(res.status).toBe(403);
});

it("POST /copilot/content/plans/:id/delete deletes a scoped plan", async () => {
  vi.mocked(copilotDeleteContentPlan).mockResolvedValue({ ok: true } as any);
  const app = makeApp();
  const res = await request(app).post("/internal/agent/copilot/content/plans/3/delete").set("x-service-token", "test-token")
    .send({ userId: 7 });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(copilotDeleteContentPlan).toHaveBeenCalledWith({ userId: 7, planId: 3 });
});

it("POST /copilot/content/plans/:id/delete rejects foreign plans", async () => {
  vi.mocked(copilotDeleteContentPlan).mockRejectedValue(new Error("Content plan not found"));
  const app = makeApp();
  const res = await request(app).post("/internal/agent/copilot/content/plans/999/delete").set("x-service-token", "test-token")
    .send({ userId: 7 });
  expect(res.status).toBe(404);
});
