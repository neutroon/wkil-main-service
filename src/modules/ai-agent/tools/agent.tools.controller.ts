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
    const out: Record<string, unknown> = {};
    if (sections.includes("stats")) {
      out.stats = await getUnifiedDashboardStats(userId, "user", days);
    }
    if (sections.includes("leads")) {
      out.leads = await listCustomers({ userId, businessProfileId, page: 1, limit });
    }
    if (sections.includes("attention")) {
      out.attention = await listCustomers({ userId, status: "handoff", page: 1, limit });
    }
    res.json(out);
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
