import { Router } from "express";
import { randomUUID } from "crypto";
import { createIntegrationActionRun } from "../../integrations/external/integrationActionRun.service";
import { assertQuotaAvailable, recordAiUsage } from "../../billing/billing.service";
import { getUnifiedDashboardStats } from "../../analytics/dashboard/dashboard.service";
import { getAiPerformanceStats } from "../../analytics/ai/analytics.service";
import { listCustomers, getCustomerForUser } from "../../business/customer/customer.service";
import prisma from "@config/prisma";
import {
  listCopilotConversations,
  getCopilotConversationMessages,
  listCopilotCustomers,
  sendCopilotMessage,
  setCopilotConversationStatus,
  toggleCopilotConversationAi,
  markCopilotConversationRead,
  updateCopilotCustomer,
  getAgentSettingsForUser,
  updateAgentSettings,
  listCopilotKnowledge,
  createCopilotKnowledge,
  updateCopilotKnowledge,
  deleteCopilotKnowledge,
  copilotListContentPlans,
  copilotGetContentPlan,
  copilotGenerateContentPlan,
  copilotGeneratePostContent,
  copilotApproveContentPost,
  copilotDeleteContentPlan,
} from "./copilot.actions.service";

const router = Router();

router.use((req, res, next) => {
  const TOKEN = process.env.MONOLITH_SERVICE_TOKEN ?? "";
  if (req.header("x-service-token") !== TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
});

router.post("/tools/run", async (req, res) => {
  const { tool, args } = req.body ?? {};
  const m = /^integration_action_(\d+)$/.exec(tool ?? "");
  if (!m) return res.status(400).json({ error: "unknown_tool", tool });
  const businessProfileId = Number(args?.businessProfileId ?? req.body.businessProfileId);
  if (!businessProfileId) return res.status(400).json({ error: "businessProfileId_required" });
  try {
    const run = await createIntegrationActionRun({
      businessProfileId,
      sourceId: Number(m[1]),
      jobId: randomUUID(),
      trigger: "CHAT_REQUESTED",
      toolName: tool,
      requestPayload: args,
    });
    res.json({ result: { runId: run.id } });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "tool_execution_failed" });
  }
});

router.get("/quota", async (req, res) => {
  const ok = await assertQuotaAvailable(Number(req.query.userId), Number(req.query.businessProfileId)).then(() => true).catch(() => false);
  res.json({ ok });
});

router.post("/usage", async (req, res) => {
  await recordAiUsage(req.body);
  res.json({ ok: true });
});

router.get("/profile/:id", async (req, res) => {
  const profile = await prisma.businessProfile.findUniqueOrThrow({
    where: { id: Number(req.params.id) },
    include: { knowledgeDocuments: { select: { id: true, kind: true, title: true, content: true } } },
  });
  res.json(profile);
});

// ---------------------------------------------------------------------------
// Copilot data tools: envelope-shaped business data for the wkil assistant.
// Queried with the VERIFIED user_id/businessProfileId injected by the channel
// BFF into the run input — never model-supplied values.
// ---------------------------------------------------------------------------

router.get("/copilot/overview", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "userId_required" });
  const businessProfileId = req.query.businessProfileId ? Number(req.query.businessProfileId) : undefined;
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
  const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  const sections = String(req.query.sections ?? "stats,leads,attention").split(",").filter(Boolean);
  try {
    const data: Record<string, unknown> = {};
    const envelopes: Record<string, unknown>[] = [];
    const cite = (section: string) => ({
      tool: "get_business_overview",
      section,
      fetchedAt: new Date().toISOString(),
    });

    if (sections.includes("stats")) {
      const s = await getUnifiedDashboardStats(userId, "user", days);
      data.stats = s;
      const hint = `Last ${days} days`;
      const totalEngagement = (s.recentPerformance ?? []).reduce(
        (sum: number, p: { totalEngagement?: number }) => sum + (p.totalEngagement || 0),
        0,
      );
      const ch = s.channelHealth ?? { facebook: false, whatsapp: false, web: false };
      const activeChannels = [ch.facebook, ch.whatsapp, ch.web].filter(Boolean).length;
      const steps = Object.values(s.setupProgress?.steps ?? {}).filter(
        (st) => st && (st as { available?: boolean }).available,
      );
      const stepsDone = steps.filter((st) => (st as { complete?: boolean }).complete).length;
      const setupPct = steps.length ? Math.round((stepsDone / steps.length) * 100) : 100;
      envelopes.push({
        type: "stat-grid",
        items: [
          // Semantic metric keys — the frontend card localizes the labels.
          { metric: "posts_created", value: s.postsCreated, period: days },
          { metric: "posts_scheduled", value: s.postsScheduled, period: days },
          { metric: "comments_replied", value: s.commentsReplied, period: days },
          { metric: "total_reach", value: s.totalReach, period: days },
          { metric: "total_engagement", value: totalEngagement, period: days },
          { metric: "ai_automation_rate", value: s.aiAutomationRate },
          { metric: "ai_accuracy_score", value: s.aiAccuracyScore },
          { metric: "lead_velocity", value: s.leadVelocity, period: days },
          { metric: "avg_response_min", value: s.avgResponseTime },
          { metric: "channels_live", value: `${activeChannels}/3` },
          { metric: "setup_complete", value: `${setupPct}%` },
        ],
        cite: { ...cite("stats"), deepLink: "/ai-analytics" },
      });
      // Daily engagement timeseries for the chart card (semantic keys only —
      // the frontend localizes the title and formats the dates).
      const perf = (s.recentPerformance ?? []) as { date: Date | string; totalEngagement?: number }[];
      const points = perf
        .map((p) => ({
          d: new Date(p.date).toISOString().slice(0, 10),
          v: Math.round(p.totalEngagement ?? 0),
        }))
        .sort((a, b) => a.d.localeCompare(b.d));
      if (points.length >= 2) {
        envelopes.push({
          type: "chart",
          chart: "engagement",
          period: days,
          points,
          cite: { ...cite("chart"), deepLink: "/ai-analytics" },
        });
      }
    }
    if (sections.includes("leads")) {
      const l = await listCustomers({ userId, businessProfileId, page: 1, limit });
      data.leads = l;
      envelopes.push({
        type: "lead-list",
        leads: l.data.map((c: any) => ({
          id: c.id,
          displayName: c.displayName,
          phone: c.phone,
          primaryChannel: c.primaryChannel,
          status: c.status,
        })),
        total: l.meta?.total ?? l.data.length,
        cite: { ...cite("leads"), deepLink: "/customers" },
      });
    }
    if (sections.includes("attention")) {
      const a = await listCustomers({ userId, status: "handoff", page: 1, limit });
      data.attention = a;
      envelopes.push({
        type: "lead-list",
        leads: a.data.map((c: any) => ({
          id: c.id,
          displayName: c.displayName,
          phone: c.phone,
          primaryChannel: c.primaryChannel,
          status: c.status,
        })),
        total: a.meta?.total ?? a.data.length,
        cite: { ...cite("attention"), deepLink: "/inbox" },
      });
    }
    res.json({ envelopes, data });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "overview_failed" });
  }
});

router.get("/copilot/customer", async (req, res) => {
  const userId = Number(req.query.userId);
  const customerId = Number(req.query.customerId);
  if (!userId || !customerId) return res.status(400).json({ error: "userId_and_customerId_required" });
  try {
    res.json({ customer: await getCustomerForUser(userId, customerId) });
  } catch (e: any) {
    res.status(404).json({ error: e?.message ?? "customer_not_found" });
  }
});

router.get("/copilot/conversations", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "userId_required" });
  try {
    const out = await listCopilotConversations({
      userId,
      businessProfileId: req.query.businessProfileId ? Number(req.query.businessProfileId) : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
      channel: req.query.channel ? String(req.query.channel) : undefined,
      q: req.query.q ? String(req.query.q) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "list_conversations_failed" });
  }
});

router.get("/copilot/conversations/:id/messages", async (req, res) => {
  const userId = Number(req.query.userId);
  const conversationId = Number(req.params.id);
  if (!userId || !conversationId) return res.status(400).json({ error: "userId_and_conversationId_required" });
  try {
    const out = await getCopilotConversationMessages({
      userId,
      conversationId,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      cursor: req.query.cursor ? Number(req.query.cursor) : undefined,
    });
    res.json(out);
  } catch (e: any) {
    res.status(404).json({ error: e?.message ?? "conversation_not_found" });
  }
});

router.get("/copilot/customers", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "userId_required" });
  try {
    const out = await listCopilotCustomers({
      userId,
      q: req.query.q ? String(req.query.q) : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "list_customers_failed" });
  }
});

// ---------------------------------------------------------------------------
// Copilot WRITE tools. The agent-svc graph pauses each write behind the
// official LangGraph interrupt() and only calls these AFTER the owner
// approved in the UI. Ownership is re-validated here (getAuthorizedConversation
// / updateCustomerForUser) — an approved-but-foreign resource is rejected.
// ---------------------------------------------------------------------------

router.post("/copilot/conversations/:id/messages", async (req, res) => {
  const userId = Number(req.body?.userId);
  const conversationId = Number(req.params.id);
  const text = String(req.body?.text ?? "");
  if (!userId || !conversationId) return res.status(400).json({ error: "userId_and_conversationId_required" });
  try {
    res.json(await sendCopilotMessage({ userId, conversationId, text }));
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "send_failed" });
  }
});

router.post("/copilot/conversations/:id/status", async (req, res) => {
  const userId = Number(req.body?.userId);
  const conversationId = Number(req.params.id);
  const status = String(req.body?.status ?? "");
  if (!userId || !conversationId) return res.status(400).json({ error: "userId_and_conversationId_required" });
  if (!["OPEN", "RESOLVED", "ARCHIVED"].includes(status)) return res.status(400).json({ error: "invalid_status" });
  try {
    res.json(await setCopilotConversationStatus({ userId, conversationId, status: status as "OPEN" | "RESOLVED" | "ARCHIVED" }));
  } catch (e: any) {
    res.status(404).json({ error: e?.message ?? "status_update_failed" });
  }
});

router.post("/copilot/conversations/:id/ai-toggle", async (req, res) => {
  const userId = Number(req.body?.userId);
  const conversationId = Number(req.params.id);
  const enabled = Boolean(req.body?.enabled);
  if (!userId || !conversationId) return res.status(400).json({ error: "userId_and_conversationId_required" });
  try {
    res.json(await toggleCopilotConversationAi({ userId, conversationId, enabled }));
  } catch (e: any) {
    res.status(404).json({ error: e?.message ?? "ai_toggle_failed" });
  }
});

router.post("/copilot/conversations/:id/read", async (req, res) => {
  const userId = Number(req.body?.userId);
  const conversationId = Number(req.params.id);
  if (!userId || !conversationId) return res.status(400).json({ error: "userId_and_conversationId_required" });
  try {
    res.json(await markCopilotConversationRead({ userId, conversationId }));
  } catch (e: any) {
    res.status(404).json({ error: e?.message ?? "mark_read_failed" });
  }
});

router.post("/copilot/customers/:id/status", async (req, res) => {
  const userId = Number(req.body?.userId);
  const customerId = Number(req.params.id);
  const status = String(req.body?.status ?? "");
  if (!userId || !customerId) return res.status(400).json({ error: "userId_and_customerId_required" });
  if (!status) return res.status(400).json({ error: "status_required" });
  try {
    res.json(await updateCopilotCustomer({ userId, customerId, data: { status } }));
  } catch (e: any) {
    res.status(404).json({ error: e?.message ?? "customer_update_failed" });
  }
});

router.post("/copilot/customers/:id/update", async (req, res) => {
  const userId = Number(req.body?.userId);
  const customerId = Number(req.params.id);
  if (!userId || !customerId) return res.status(400).json({ error: "userId_and_customerId_required" });
  try {
    res.json(await updateCopilotCustomer({
      userId,
      customerId,
      data: {
        ...(req.body?.notes !== undefined ? { notes: req.body.notes } : {}),
        ...(req.body?.displayName ? { displayName: String(req.body.displayName) } : {}),
      },
    }));
  } catch (e: any) {
    res.status(404).json({ error: e?.message ?? "customer_update_failed" });
  }
});

router.get("/copilot/usage", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "userId_required" });
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
  try {
    res.json({ usage: await getAiPerformanceStats(String(userId), "user", days) });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "usage_failed" });
  }
});

// ---------------------------------------------------------------------------
// Copilot agent settings + knowledge tools (consumed by agent-svc
// get_agent_settings / update_agent_settings / list_knowledge / add_knowledge /
// update_knowledge / delete_knowledge). { userId } is injected by the channel
// BFF into the run input — never model-supplied values.
// ---------------------------------------------------------------------------

router.get("/copilot/agent-settings", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "userId_required" });
  try {
    res.json(await getAgentSettingsForUser({
      userId,
      businessProfileId: req.query.businessProfileId ? Number(req.query.businessProfileId) : undefined,
    }));
  } catch (e: any) {
    res.status(404).json({ error: e?.message ?? "settings_not_found" });
  }
});

router.post("/copilot/agent-settings", async (req, res) => {
  const userId = Number(req.body?.userId);
  if (!userId) return res.status(400).json({ error: "userId_required" });
  try {
    res.json(await updateAgentSettings({
      userId,
      businessProfileId: req.body?.businessProfileId ? Number(req.body.businessProfileId) : undefined,
      patch: req.body ?? {},
    }));
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "settings_update_failed" });
  }
});

router.get("/copilot/knowledge", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "userId_required" });
  try {
    res.json(await listCopilotKnowledge({
      userId,
      businessProfileId: req.query.businessProfileId ? Number(req.query.businessProfileId) : undefined,
      kind: req.query.kind ? String(req.query.kind) : undefined,
      q: req.query.q ? String(req.query.q) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "list_knowledge_failed" });
  }
});

router.post("/copilot/knowledge", async (req, res) => {
  const userId = Number(req.body?.userId);
  if (!userId) return res.status(400).json({ error: "userId_required" });
  try {
    res.json(await createCopilotKnowledge({
      userId,
      businessProfileId: req.body?.businessProfileId ? Number(req.body.businessProfileId) : undefined,
      kind: String(req.body?.kind ?? ""),
      title: req.body?.title ? String(req.body.title) : undefined,
      content: String(req.body?.content ?? ""),
    }));
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "create_knowledge_failed" });
  }
});

router.put("/copilot/knowledge/:id", async (req, res) => {
  const userId = Number(req.body?.userId);
  const documentId = Number(req.params.id);
  if (!userId || !documentId) return res.status(400).json({ error: "userId_and_documentId_required" });
  try {
    res.json(await updateCopilotKnowledge({
      userId,
      businessProfileId: req.body?.businessProfileId ? Number(req.body.businessProfileId) : undefined,
      documentId,
      kind: req.body?.kind ? String(req.body.kind) : undefined,
      title: req.body?.title ? String(req.body.title) : undefined,
      content: req.body?.content ? String(req.body.content) : undefined,
    }));
  } catch (e: any) {
    res.status(404).json({ error: e?.message ?? "update_knowledge_failed" });
  }
});

router.post("/copilot/knowledge/:id/delete", async (req, res) => {
  const userId = Number(req.body?.userId);
  const documentId = Number(req.params.id);
  if (!userId || !documentId) return res.status(400).json({ error: "userId_and_documentId_required" });
  try {
    res.json(await deleteCopilotKnowledge({
      userId,
      businessProfileId: req.body?.businessProfileId ? Number(req.body.businessProfileId) : undefined,
      documentId,
    }));
  } catch (e: any) {
    res.status(404).json({ error: e?.message ?? "delete_knowledge_failed" });
  }
});

// ---------------------------------------------------------------------------
// Copilot content tools (list/get/generate/approve/delete content plans and
// posts). { userId } is injected by the channel BFF into the run input — never
// model-supplied values. Ownership is re-validated in the content service.
// ---------------------------------------------------------------------------

router.get("/copilot/content/plans", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "userId_required" });
  try {
    res.json(await copilotListContentPlans({
      userId,
      businessProfileId: req.query.businessProfileId ? Number(req.query.businessProfileId) : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "list_content_plans_failed" });
  }
});

router.get("/copilot/content/plans/:id", async (req, res) => {
  const userId = Number(req.query.userId);
  const planId = Number(req.params.id);
  if (!userId || !planId) return res.status(400).json({ error: "userId_and_planId_required" });
  try {
    res.json(await copilotGetContentPlan({ userId, planId }));
  } catch (e: any) {
    res.status(404).json({ error: e?.message ?? "content_plan_not_found" });
  }
});

router.post("/copilot/content/plans/generate", async (req, res) => {
  const userId = Number(req.body?.userId);
  const businessProfileId = Number(req.body?.businessProfileId);
  const draft = req.body?.draft;
  if (!userId || !businessProfileId) return res.status(400).json({ error: "userId_and_businessProfileId_required" });
  if (!draft || !Array.isArray(draft.posts) || draft.posts.length === 0) return res.status(400).json({ error: "draft_posts_required" });
  try {
    res.json(await copilotGenerateContentPlan({
      userId,
      businessProfileId,
      draft,
      goal: req.body?.goal ? String(req.body.goal) : undefined,
      platform: req.body?.platform ? String(req.body.platform) : undefined,
    }));
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "generate_content_plan_failed" });
  }
});

router.post("/copilot/content/posts/:id/generate", async (req, res) => {
  const userId = Number(req.body?.userId);
  const postId = Number(req.params.id);
  const caption = String(req.body?.caption ?? "");
  if (!userId || !postId) return res.status(400).json({ error: "userId_and_postId_required" });
  if (!caption) return res.status(400).json({ error: "caption_required" });
  try {
    res.json(await copilotGeneratePostContent({
      userId,
      postId,
      caption,
      imagePrompt: req.body?.imagePrompt ? String(req.body.imagePrompt) : undefined,
    }));
  } catch (e: any) {
    res.status(404).json({ error: e?.message ?? "generate_post_content_failed" });
  }
});

router.post("/copilot/content/posts/:id/approve", async (req, res) => {
  const userId = Number(req.body?.userId);
  const postId = Number(req.params.id);
  if (!userId || !postId) return res.status(400).json({ error: "userId_and_postId_required" });
  try {
    res.json(await copilotApproveContentPost({ userId, postId }));
  } catch (e: any) {
    res.status(403).json({ error: e?.message ?? "approve_post_failed" });
  }
});

router.post("/copilot/content/plans/:id/delete", async (req, res) => {
  const userId = Number(req.body?.userId);
  const planId = Number(req.params.id);
  if (!userId || !planId) return res.status(400).json({ error: "userId_and_planId_required" });
  try {
    res.json(await copilotDeleteContentPlan({ userId, planId }));
  } catch (e: any) {
    res.status(404).json({ error: e?.message ?? "delete_content_plan_failed" });
  }
});

export default router;
