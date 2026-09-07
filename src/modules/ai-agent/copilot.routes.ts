import { Router } from "express";
import prisma from "@config/prisma";
import { assistantGateway } from "./assistant.gateway";

/**
 * App-facing copilot routes (session-authenticated — mounted behind
 * authenticateToken in app.ts). Data-tool traffic goes through
 * /internal/agent (service-token); this router serves the BROWSER.
 */
const copilotRoutes = Router();

const RATINGS = new Set(["positive", "negative"]);

copilotRoutes.post("/feedback", async (req, res) => {
  const userId = (req as any).user?.id;
  const { threadId, messageId, rating, comment } = req.body ?? {};
  if (!userId || !messageId || !RATINGS.has(rating)) {
    return res.status(400).json({ error: "invalid_feedback" });
  }
  try {
    const saved = await prisma.copilotFeedback.upsert({
      where: { userId_messageId: { userId, messageId: String(messageId) } },
      create: {
        userId,
        messageId: String(messageId),
        rating,
        threadId: threadId ? String(threadId) : null,
        comment: comment ? String(comment).slice(0, 1000) : null,
      },
      update: {
        rating,
        threadId: threadId ? String(threadId) : undefined,
        comment: comment ? String(comment).slice(0, 1000) : undefined,
      },
    });
    res.json({ ok: true, id: saved.id });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "feedback_failed" });
  }
});

// All other allow-listed LangGraph resources are handled by the shared
// gateway. It is intentionally mounted after feedback so the legacy feedback
// endpoint remains a normal JSON API while web and native chat share one
// transport and one authorization boundary.
copilotRoutes.use(assistantGateway);

export default copilotRoutes;
