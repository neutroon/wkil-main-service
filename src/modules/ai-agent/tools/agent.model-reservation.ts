import { Router } from "express";
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
    // Compatibility only: admission is the run-level /quota check and billing
    // is based on confirmed /usage events. Historical rows are left intact.
    return res.json({ ok: true, reservedCredits: 0 });
  } catch (error: any) {
    return res.status(error?.statusCode ?? 503).json({ error: "model_reservation_denied" });
  }
});

router.post("/release", async (req, res) => {
  const { userId, eventId } = req.body ?? {};
  if (!Number.isSafeInteger(userId) || userId <= 0 || typeof eventId !== "string") return res.status(400).json({ error: "invalid_reservation" });
  // Legacy callers may still release while old and new deployments overlap.
  // No reservation is created or removed by this compatibility endpoint.
  return res.json({ ok: true });
});
export default router;
