import { Router } from "express";
import { randomUUID } from "crypto";
import { createIntegrationActionRun } from "../../integrations/external/integrationActionRun.service";
import { assertQuotaAvailable, recordAiUsage } from "../../billing/billing.service";
import { getUnifiedDashboardStats } from "../../analytics/dashboard/dashboard.service";
import { getAiPerformanceStats } from "../../analytics/ai/analytics.service";
import { listCustomers, getCustomerForUser } from "../../business/customer/customer.service";
import prisma from "@config/prisma";

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
    where: { id: Number(req.params.id) }, include: { faqs: true, knowledgeSections: true },
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

export default router;
