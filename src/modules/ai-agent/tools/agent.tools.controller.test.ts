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
  copilotListMedia: vi.fn(),
  copilotUpdateMediaAsset: vi.fn(),
  copilotDeleteMediaAsset: vi.fn(),
  copilotRetryMediaSync: vi.fn(),
  copilotGenerateVisual: vi.fn(),
  copilotListOrders: vi.fn(),
  copilotListOrderIntegrations: vi.fn(),
  copilotUpdateOrderIntegration: vi.fn(),
  copilotRetryOrderNotification: vi.fn(),
  copilotRetryOrderSync: vi.fn(),
  copilotListWhatsAppAccounts: vi.fn(),
  copilotWhatsAppAccountAction: vi.fn(),
  copilotListFacebookPages: vi.fn(),
  copilotFacebookPageAction: vi.fn(),
  copilotListWidgetInstalls: vi.fn(),
  copilotWidgetAction: vi.fn(),
  copilotUpdateAccount: vi.fn(),
}));
vi.mock("./socialCopilot.service", () => ({
  listCopilotFacebookPages: vi.fn(),
  listCopilotPagePosts: vi.fn(),
  listCopilotPostComments: vi.fn(),
  createCopilotPost: vi.fn(),
  deleteCopilotPost: vi.fn(),
  replyCopilotComment: vi.fn(),
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
  copilotListMedia,
  copilotGenerateVisual,
  copilotRetryOrderNotification,
  copilotWhatsAppAccountAction,
  copilotWidgetAction,
  copilotUpdateAccount,
} from "./copilot.actions.service";
import {
  createCopilotPost,
  replyCopilotComment,
} from "./socialCopilot.service";

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

// --- copilot social tools ---

it("POST /copilot/social/posts delegates create with pageId/text", async () => {
  vi.mocked(createCopilotPost).mockResolvedValue({ ok: true, post: { id: "PG1_9" } } as any);
  const app = makeApp();
  const res = await request(app).post("/internal/agent/copilot/social/posts").set("x-service-token", "test-token")
    .send({ userId: 7, pageId: "PG1", text: "Hello", imageUrl: "https://x/y.png" });
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);
  expect(createCopilotPost).toHaveBeenCalledWith({
    userId: 7, pageId: "PG1", text: "Hello", imageUrl: "https://x/y.png", scheduledAt: undefined,
  });
});

it("POST /copilot/social/posts rejects posts to foreign pages with 404", async () => {
  vi.mocked(createCopilotPost).mockRejectedValue(Object.assign(new Error("Facebook page not found."), { statusCode: 404 }));
  const app = makeApp();
  const res = await request(app).post("/internal/agent/copilot/social/posts").set("x-service-token", "test-token")
    .send({ userId: 7, pageId: "FOREIGN", text: "hi" });
  expect(res.status).toBe(404);
});

it("POST /copilot/social/comments/:id/reply delegates with text", async () => {
  vi.mocked(replyCopilotComment).mockResolvedValue({ ok: true } as any);
  const app = makeApp();
  const res = await request(app).post("/internal/agent/copilot/social/comments/PG1_9_1/reply").set("x-service-token", "test-token")
    .send({ userId: 7, text: "Thanks!" });
  expect(res.status).toBe(200);
  expect(replyCopilotComment).toHaveBeenCalledWith({ userId: 7, commentId: "PG1_9_1", text: "Thanks!" });
});

// --- copilot media tools ---

it("POST /copilot/media/ai rejects foreign assets with 404", async () => {
  vi.mocked(copilotGenerateVisual).mockRejectedValue(Object.assign(new Error("Asset not found"), { statusCode: 404 }));
  const app = makeApp();
  const res = await request(app).post("/internal/agent/copilot/media/ai").set("x-service-token", "test-token")
    .send({ userId: 7, prompt: "make it pop", action: "refine", assetId: 999 });
  expect(res.status).toBe(404);
  expect(copilotGenerateVisual).toHaveBeenCalledWith({ userId: 7, prompt: "make it pop", action: "refine", assetId: 999, postId: undefined });
});

it("GET /copilot/media delegates listing", async () => {
  vi.mocked(copilotListMedia).mockResolvedValue({ assets: [{ id: 4 }] } as any);
  const app = makeApp();
  const res = await request(app).get("/internal/agent/copilot/media?userId=7&usageScope=CONTENT_ASSET").set("x-service-token", "test-token");
  expect(res.status).toBe(200);
  expect(res.body.assets).toHaveLength(1);
  expect(copilotListMedia).toHaveBeenCalledWith({ userId: 7, usageScope: "CONTENT_ASSET" });
});

// --- copilot orders tools ---

it("POST /copilot/orders/notifications/:id/retry rejects foreign notifications with 404", async () => {
  vi.mocked(copilotRetryOrderNotification).mockRejectedValue(Object.assign(new Error("Order notification not found"), { statusCode: 404 }));
  const app = makeApp();
  const res = await request(app).post("/internal/agent/copilot/orders/notifications/999/retry").set("x-service-token", "test-token")
    .send({ userId: 7 });
  expect(res.status).toBe(404);
});

it("POST /copilot/orders/notifications/:id/retry surfaces conflicts as 409", async () => {
  vi.mocked(copilotRetryOrderNotification).mockRejectedValue(Object.assign(new Error("Only failed notifications can be retried"), { statusCode: 409 }));
  const app = makeApp();
  const res = await request(app).post("/internal/agent/copilot/orders/notifications/5/retry").set("x-service-token", "test-token")
    .send({ userId: 7 });
  expect(res.status).toBe(409);
});

// --- copilot channels tools ---

it("POST /copilot/channels/whatsapp/:id/action delegates the action", async () => {
  vi.mocked(copilotWhatsAppAccountAction).mockResolvedValue({ ok: true, account: { id: 4 } } as any);
  const app = makeApp();
  const res = await request(app).post("/internal/agent/copilot/channels/whatsapp/4/action").set("x-service-token", "test-token")
    .send({ userId: 7, action: "link", businessProfileId: 3 });
  expect(res.status).toBe(200);
  expect(copilotWhatsAppAccountAction).toHaveBeenCalledWith({ userId: 7, accountId: 4, action: "link", businessProfileId: 3 });
});

it("POST /copilot/channels/widgets/action creates an install", async () => {
  vi.mocked(copilotWidgetAction).mockResolvedValue({ ok: true, install: { id: 9, publicSiteKey: "wsk_abc" } } as any);
  const app = makeApp();
  const res = await request(app).post("/internal/agent/copilot/channels/widgets/action").set("x-service-token", "test-token")
    .send({ userId: 7, action: "create", businessProfileId: 3, allowedOrigins: ["https://a.com"] });
  expect(res.status).toBe(200);
  expect(res.body.install.publicSiteKey).toBe("wsk_abc");
  expect(copilotWidgetAction).toHaveBeenCalledWith({
    userId: 7, action: "create", installId: undefined,
    allowedOrigins: ["https://a.com"], isActive: undefined, businessProfileId: 3,
  });
});

// --- copilot account ---

it("POST /copilot/account delegates with mapped avatarUrl", async () => {
  vi.mocked(copilotUpdateAccount).mockResolvedValue({ ok: true, user: { id: 7, name: "Hesham" } } as any);
  const app = makeApp();
  const res = await request(app).post("/internal/agent/copilot/account").set("x-service-token", "test-token")
    .send({ userId: 7, name: "Hesham", avatarUrl: "https://a.png" });
  expect(res.status).toBe(200);
  expect(copilotUpdateAccount).toHaveBeenCalledWith({ userId: 7, name: "Hesham", avatarUrl: "https://a.png" });
});

it("POST /copilot/account requires userId", async () => {
  const app = makeApp();
  const res = await request(app).post("/internal/agent/copilot/account").set("x-service-token", "test-token")
    .send({ name: "Hesham" });
  expect(res.status).toBe(400);
});
