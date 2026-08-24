import { Request, Response } from "express";
import { cancelCopilotRun, startCopilotTurn, activeRuns } from "./copilot.service";
import {
  getCopilotConversationForUser,
  getOrCreateCopilotConversation,
  listCopilotMessages,
} from "./copilot.store";

function detectLocale(req: Request): "ar" | "en" {
  const al = (req.headers["accept-language"] as string | undefined) ?? "";
  return al.toLowerCase().startsWith("ar") ? "ar" : "en";
}

export const getCopilotConversationController = async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const locale = detectLocale(req);
  // Ensure a thread exists for this user so the frontend always has one to query.
  const conv = await getOrCreateCopilotConversation(userId, locale);
  res.status(200).json({ data: conv });
};

export const listCopilotMessagesController = async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const limit = ((req.query as any).limit as number | undefined) ?? 50;
  const conv = await getOrCreateCopilotConversation(userId, detectLocale(req));
  const messages = await listCopilotMessages(conv.id, limit);
  res.status(200).json({ data: messages });
};

export const postCopilotMessageController = async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const { text } = (req as any).body as { text: string };
  const locale = detectLocale(req);
  const result = await startCopilotTurn({ userId, text, locale });
  res.status(200).json({ data: { runId: result.runId, conversationId: result.conversationId } });
};

export const cancelCopilotRunController = async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const runId = (req as any).params.runId as string;
  const out = await cancelCopilotRun(runId, userId);
  if (out.cancelled) {
    res.status(200).json({ data: { cancelled: true } });
    return;
  }
    // Determine 403 vs 404: peek at activeRuns
  const exists = activeRuns.has(runId);
  if (!exists) {
    res.status(404).json({ data: { cancelled: false, message: "no active run" } });
  } else {
    res.status(403).json({ data: { cancelled: false, message: "forbidden" } });
  }
};
