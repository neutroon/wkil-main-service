import { Router } from "express";
import { runAgentActionTool } from "../core/agentActionTools"; // existing business logic
import { assertQuotaAvailable, recordAiUsage } from "../../billing/billing.service";
import prisma from "@config/prisma";

const router = Router();
const TOKEN = process.env.MONOLITH_SERVICE_TOKEN ?? "";

router.use((req, res, next) => {
  if (req.header("x-service-token") !== TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
});

router.post("/tools/run", async (req, res) => {
  const { tool, tool_call_id, args } = req.body;
  const result = await runAgentActionTool(tool, args);
  res.json({ result });
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
