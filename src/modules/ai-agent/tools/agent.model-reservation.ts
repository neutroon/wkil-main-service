import { Router } from "express";
import prisma from "@config/prisma";
import { calculateCustomerCost } from "@modules/billing/billing.service";
import { CREDIT_VALUE_USD, PLAN_CREDIT_LIMITS } from "@modules/billing/billing.config";
import { requireWorkspaceProfileAccess } from "@modules/workspace/workspace.service";

const router = Router();
router.post("/reserve", async (req, res) => {
  const { eventId, userId, businessProfileId, modelName, promptTokens, completionTokens } = req.body ?? {};
  if (typeof eventId !== "string" || !eventId || eventId.length > 200 || typeof modelName !== "string" || !modelName ||
      !Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(promptTokens) || promptTokens < 0 || promptTokens > 128000 ||
      !Number.isSafeInteger(completionTokens) || completionTokens < 1 || completionTokens > 4096) {
    return res.status(400).json({ error: "invalid_model_reservation" });
  }
  try {
    if (businessProfileId) await requireWorkspaceProfileAccess(userId, businessProfileId);
    // Include a conservative margin for approximate prompt counting/tool schemas.
    const { customerCost } = await calculateCustomerCost({ modelName, promptTokens: Math.ceil(promptTokens * 1.5) + 8000, completionTokens });
    const reservedCredits = Math.ceil(customerCost / CREDIT_VALUE_USD);
    await prisma.$transaction(async (tx) => {
      await tx.agentModelReservation.create({ data: { userId, eventId, reservedCredits, businessProfileId } });
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { plan: true, monthlyCreditQuota: true, monthlyCreditsUsed: true } });
      const limit = user.monthlyCreditQuota || PLAN_CREDIT_LIMITS[user.plan] || PLAN_CREDIT_LIMITS.FREE;
      if (user.monthlyCreditsUsed + reservedCredits > limit) throw Object.assign(new Error("insufficient_model_budget"), { statusCode: 402 });
    });
    return res.json({ ok: true, reservedCredits });
  } catch (error: any) {
    return res.status(error?.code === "P2002" ? 409 : error?.statusCode ?? 503).json({ error: error?.code === "P2002" ? "model_call_in_progress_or_requires_reconciliation" : "model_reservation_denied" });
  }
});

router.post("/release", async (req, res) => {
  const { userId, eventId, rejectedStatus } = req.body ?? {};
  if (!Number.isSafeInteger(userId) || userId <= 0 || typeof eventId !== "string") return res.status(400).json({ error: "invalid_reservation" });
  try {
    if ([400, 401, 403, 404, 422, 429].includes(rejectedStatus)) {
      await prisma.agentModelReservation.deleteMany({ where: { userId, eventId } });
      return res.json({ ok: true });
    }
    const usage = await prisma.aiCallLog.findUnique({ where: { eventId } });
    if (!usage || usage.userId !== userId) return res.status(409).json({ error: "usage_must_be_recorded_before_release" });
    await prisma.agentModelReservation.deleteMany({ where: { userId, eventId } });
    return res.json({ ok: true });
  } catch { return res.status(503).json({ error: "reservation_release_failed" }); }
});
export default router;
