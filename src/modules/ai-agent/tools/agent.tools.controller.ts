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
  copilotListMedia,
  copilotUpdateMediaAsset,
  copilotDeleteMediaAsset,
  copilotRetryMediaSync,
  copilotGenerateVisual,
  copilotListOrders,
  copilotListOrderIntegrations,
  copilotUpdateOrderIntegration,
  copilotRetryOrderNotification,
  copilotRetryOrderSync,
  copilotListWhatsAppAccounts,
  copilotWhatsAppAccountAction,
  copilotListFacebookPages,
  copilotFacebookPageAction,
  copilotListWidgetInstalls,
  copilotWidgetAction,
  copilotUpdateAccount,
} from "./copilot.actions.service";
import {
  listCopilotFacebookPages,
  listCopilotPagePosts,
  listCopilotPostComments,
  createCopilotPost,
  deleteCopilotPost,
  replyCopilotComment,
} from "./socialCopilot.service";

const router = Router();

const errStatus = (e: any, fallback: number) =>
  typeof e?.statusCode === "number" ? e.statusCode : fallback;

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

// ---------------------------------------------------------------------------
// Copilot social tools (list_facebook_posts / list_post_comments /
// create_facebook_post / schedule_facebook_post / delete_facebook_post /
// reply_to_comment). The socialCopilot wrapper asserts page ownership
// (facebookAccount.userId) before any facebook.service delegation.
// ---------------------------------------------------------------------------

router.get("/copilot/social/pages", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "userId_required" });
  try {
    res.json(await listCopilotFacebookPages(userId));
  } catch (e: any) {
    res.status(errStatus(e, 500)).json({ error: e?.message ?? "list_pages_failed" });
  }
});

router.get("/copilot/social/pages/:pageId/posts", async (req, res) => {
  const userId = Number(req.query.userId);
  const pageId = String(req.params.pageId ?? "");
  if (!userId || !pageId) return res.status(400).json({ error: "userId_and_pageId_required" });
  try {
    res.json(await listCopilotPagePosts({ userId, pageId }));
  } catch (e: any) {
    res.status(errStatus(e, 404)).json({ error: e?.message ?? "list_posts_failed" });
  }
});

router.get("/copilot/social/posts/:postId/comments", async (req, res) => {
  const userId = Number(req.query.userId);
  const postId = String(req.params.postId ?? "");
  if (!userId || !postId) return res.status(400).json({ error: "userId_and_postId_required" });
  try {
    res.json(await listCopilotPostComments({ userId, postId }));
  } catch (e: any) {
    res.status(errStatus(e, 404)).json({ error: e?.message ?? "list_comments_failed" });
  }
});

router.post("/copilot/social/posts", async (req, res) => {
  const userId = Number(req.body?.userId);
  const pageId = req.body?.pageId != null ? String(req.body.pageId) : "";
  const text = String(req.body?.text ?? "");
  if (!userId || !pageId) return res.status(400).json({ error: "userId_and_pageId_required" });
  if (!text) return res.status(400).json({ error: "text_required" });
  try {
    res.json(await createCopilotPost({
      userId,
      pageId,
      text,
      imageUrl: req.body?.imageUrl ? String(req.body.imageUrl) : undefined,
      scheduledAt: req.body?.scheduledAt ? String(req.body.scheduledAt) : undefined,
    }));
  } catch (e: any) {
    res.status(errStatus(e, 400)).json({ error: e?.message ?? "create_post_failed" });
  }
});

router.post("/copilot/social/posts/:postId/delete", async (req, res) => {
  const userId = Number(req.body?.userId);
  const postId = String(req.params.postId ?? "");
  if (!userId || !postId) return res.status(400).json({ error: "userId_and_postId_required" });
  try {
    res.json(await deleteCopilotPost({ userId, postId }));
  } catch (e: any) {
    res.status(errStatus(e, 404)).json({ error: e?.message ?? "delete_post_failed" });
  }
});

router.post("/copilot/social/comments/:commentId/reply", async (req, res) => {
  const userId = Number(req.body?.userId);
  const commentId = String(req.params.commentId ?? "");
  const text = String(req.body?.text ?? "");
  if (!userId || !commentId) return res.status(400).json({ error: "userId_and_commentId_required" });
  if (!text) return res.status(400).json({ error: "text_required" });
  try {
    res.json(await replyCopilotComment({ userId, commentId, text }));
  } catch (e: any) {
    res.status(errStatus(e, 400)).json({ error: e?.message ?? "reply_failed" });
  }
});

// ---------------------------------------------------------------------------
// Copilot media tools (list_media_assets / update_media_asset /
// delete_media_asset / retry_media_sync / generate_media_visual). Ownership is
// re-validated before enqueueing AI work.
// ---------------------------------------------------------------------------

router.get("/copilot/media", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "userId_required" });
  try {
    res.json(await copilotListMedia({
      userId,
      usageScope: req.query.usageScope ? String(req.query.usageScope) : undefined,
    }));
  } catch (e: any) {
    res.status(errStatus(e, 500)).json({ error: e?.message ?? "list_media_failed" });
  }
});

router.patch("/copilot/media/:id", async (req, res) => {
  const userId = Number(req.body?.userId);
  const assetId = Number(req.params.id);
  if (!userId || !assetId) return res.status(400).json({ error: "userId_and_assetId_required" });
  try {
    res.json(await copilotUpdateMediaAsset({
      userId,
      assetId,
      name: req.body?.name !== undefined ? String(req.body.name) : undefined,
      instructions: req.body?.instructions !== undefined ? String(req.body.instructions) : undefined,
    }));
  } catch (e: any) {
    res.status(errStatus(e, 404)).json({ error: e?.message ?? "update_media_failed" });
  }
});

router.post("/copilot/media/:id/delete", async (req, res) => {
  const userId = Number(req.body?.userId);
  const assetId = Number(req.params.id);
  if (!userId || !assetId) return res.status(400).json({ error: "userId_and_assetId_required" });
  try {
    res.json(await copilotDeleteMediaAsset({ userId, assetId }));
  } catch (e: any) {
    res.status(errStatus(e, 404)).json({ error: e?.message ?? "delete_media_failed" });
  }
});

router.post("/copilot/media/:id/retry", async (req, res) => {
  const userId = Number(req.body?.userId);
  const assetId = Number(req.params.id);
  if (!userId || !assetId) return res.status(400).json({ error: "userId_and_assetId_required" });
  try {
    res.json(await copilotRetryMediaSync({ userId, assetId }));
  } catch (e: any) {
    res.status(errStatus(e, 404)).json({ error: e?.message ?? "retry_media_sync_failed" });
  }
});

router.post("/copilot/media/ai", async (req, res) => {
  const userId = Number(req.body?.userId);
  const prompt = String(req.body?.prompt ?? "");
  const action = String(req.body?.action ?? "");
  if (!userId || !prompt) return res.status(400).json({ error: "userId_and_prompt_required" });
  if (!["generate", "refine"].includes(action)) return res.status(400).json({ error: "invalid_action" });
  try {
    res.json(await copilotGenerateVisual({
      userId,
      prompt,
      action: action as "generate" | "refine",
      assetId: req.body?.assetId ? Number(req.body.assetId) : undefined,
      postId: req.body?.postId ? Number(req.body.postId) : undefined,
    }));
  } catch (e: any) {
    res.status(errStatus(e, 400)).json({ error: e?.message ?? "media_ai_failed" });
  }
});

// ---------------------------------------------------------------------------
// Copilot order tools (list_orders / list_order_integrations /
// update_order_integration / retry_order_notification / retry_order_sync).
// Scoped via getAccessibleProfileIds; idempotent retries surface as 409.
// ---------------------------------------------------------------------------

router.get("/copilot/orders", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "userId_required" });
  try {
    res.json(await copilotListOrders({
      userId,
      status: req.query.status ? String(req.query.status) : undefined,
      page: req.query.page ? Number(req.query.page) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (e: any) {
    res.status(errStatus(e, 500)).json({ error: e?.message ?? "list_orders_failed" });
  }
});

router.get("/copilot/orders/integrations", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "userId_required" });
  try {
    res.json(await copilotListOrderIntegrations({ userId }));
  } catch (e: any) {
    res.status(errStatus(e, 500)).json({ error: e?.message ?? "list_order_integrations_failed" });
  }
});

router.patch("/copilot/orders/integrations/:id", async (req, res) => {
  const userId = Number(req.body?.userId);
  const integrationId = Number(req.params.id);
  if (!userId || !integrationId) return res.status(400).json({ error: "userId_and_integrationId_required" });
  try {
    res.json(await copilotUpdateOrderIntegration({
      userId,
      integrationId,
      isActive: req.body?.isActive !== undefined ? Boolean(req.body.isActive) : undefined,
      storeSyncEnabled: req.body?.storeSyncEnabled !== undefined ? Boolean(req.body.storeSyncEnabled) : undefined,
      defaultLocale: req.body?.defaultLocale !== undefined ? String(req.body.defaultLocale) : undefined,
    }));
  } catch (e: any) {
    res.status(errStatus(e, 404)).json({ error: e?.message ?? "update_order_integration_failed" });
  }
});

router.post("/copilot/orders/notifications/:id/retry", async (req, res) => {
  const userId = Number(req.body?.userId);
  const notificationId = Number(req.params.id);
  if (!userId || !notificationId) return res.status(400).json({ error: "userId_and_notificationId_required" });
  try {
    res.json(await copilotRetryOrderNotification({ userId, notificationId }));
  } catch (e: any) {
    res.status(errStatus(e, 404)).json({ error: e?.message ?? "retry_notification_failed" });
  }
});

router.post("/copilot/orders/sync/:id/retry", async (req, res) => {
  const userId = Number(req.body?.userId);
  const syncId = Number(req.params.id);
  if (!userId || !syncId) return res.status(400).json({ error: "userId_and_syncId_required" });
  try {
    res.json(await copilotRetryOrderSync({ userId, syncId }));
  } catch (e: any) {
    res.status(errStatus(e, 404)).json({ error: e?.message ?? "retry_sync_failed" });
  }
});

// ---------------------------------------------------------------------------
// Copilot channel tools (WhatsApp accounts / Facebook pages / web widgets).
// Inline-prisma patterns cloned from the channel controllers with ownership
// re-validated before every mutation.
// ---------------------------------------------------------------------------

router.get("/copilot/channels/whatsapp", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "userId_required" });
  try {
    res.json(await copilotListWhatsAppAccounts(userId));
  } catch (e: any) {
    res.status(errStatus(e, 500)).json({ error: e?.message ?? "list_whatsapp_failed" });
  }
});

router.post("/copilot/channels/whatsapp/:id/action", async (req, res) => {
  const userId = Number(req.body?.userId);
  const accountId = Number(req.params.id);
  const action = String(req.body?.action ?? "");
  if (!userId || !accountId) return res.status(400).json({ error: "userId_and_accountId_required" });
  try {
    res.json(await copilotWhatsAppAccountAction({
      userId,
      accountId,
      action,
      businessProfileId: req.body?.businessProfileId ? Number(req.body.businessProfileId) : undefined,
    }));
  } catch (e: any) {
    res.status(errStatus(e, 404)).json({ error: e?.message ?? "whatsapp_action_failed" });
  }
});

router.get("/copilot/channels/facebook", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "userId_required" });
  try {
    res.json(await copilotListFacebookPages(userId));
  } catch (e: any) {
    res.status(errStatus(e, 500)).json({ error: e?.message ?? "list_facebook_pages_failed" });
  }
});

router.post("/copilot/channels/facebook/:pageId/action", async (req, res) => {
  const userId = Number(req.body?.userId);
  const pageId = String(req.params.pageId ?? "");
  const action = String(req.body?.action ?? "");
  if (!userId || !pageId) return res.status(400).json({ error: "userId_and_pageId_required" });
  try {
    res.json(await copilotFacebookPageAction({
      userId,
      pageId,
      action,
      businessProfileId: req.body?.businessProfileId ? Number(req.body.businessProfileId) : undefined,
      commentAutoDmEnabled: req.body?.commentAutoDmEnabled !== undefined ? Boolean(req.body.commentAutoDmEnabled) : undefined,
      commentPublicGreeting: req.body?.commentPublicGreeting !== undefined ? String(req.body.commentPublicGreeting) : undefined,
    }));
  } catch (e: any) {
    res.status(errStatus(e, 404)).json({ error: e?.message ?? "facebook_action_failed" });
  }
});

router.get("/copilot/channels/widgets", async (req, res) => {
  const userId = Number(req.query.userId);
  if (!userId) return res.status(400).json({ error: "userId_required" });
  try {
    res.json(await copilotListWidgetInstalls(userId));
  } catch (e: any) {
    res.status(errStatus(e, 500)).json({ error: e?.message ?? "list_widgets_failed" });
  }
});

router.post("/copilot/channels/widgets/action", async (req, res) => {
  const userId = Number(req.body?.userId);
  const action = String(req.body?.action ?? "");
  if (!userId) return res.status(400).json({ error: "userId_required" });
  try {
    res.json(await copilotWidgetAction({
      userId,
      action,
      installId: req.body?.installId ? Number(req.body.installId) : undefined,
      allowedOrigins: Array.isArray(req.body?.allowedOrigins) ? req.body.allowedOrigins.map(String) : undefined,
      isActive: req.body?.isActive !== undefined ? Boolean(req.body.isActive) : undefined,
      businessProfileId: req.body?.businessProfileId ? Number(req.body.businessProfileId) : undefined,
    }));
  } catch (e: any) {
    res.status(errStatus(e, 404)).json({ error: e?.message ?? "widget_action_failed" });
  }
});

// ---------------------------------------------------------------------------
// Copilot account tool (update_account) — name/avatarUrl → profile update.
// ---------------------------------------------------------------------------

router.post("/copilot/account", async (req, res) => {
  const userId = Number(req.body?.userId);
  if (!userId) return res.status(400).json({ error: "userId_required" });
  try {
    res.json(await copilotUpdateAccount({
      userId,
      name: req.body?.name !== undefined ? String(req.body.name) : undefined,
      avatarUrl: req.body?.avatarUrl !== undefined ? String(req.body.avatarUrl) : undefined,
    }));
  } catch (e: any) {
    res.status(errStatus(e, 404)).json({ error: e?.message ?? "account_update_failed" });
  }
});

export default router;
