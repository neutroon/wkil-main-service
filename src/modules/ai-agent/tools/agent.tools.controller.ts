import { Router } from "express";
import { randomUUID } from "crypto";
import { createIntegrationActionRun } from "../../integrations/external/integrationActionRun.service";
import { assertQuotaAvailable, recordAiUsage } from "../../billing/billing.service";
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

export default router;
