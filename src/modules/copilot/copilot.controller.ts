import { Request, Response } from "express";
import { cancelCopilotRun, startCopilotTurn, startCopilotRegenerate, activeRuns } from "./copilot.service";
import {
  createConversation,
  deleteConversation,
  getCopilotConversationForUser,
  getOrCreateCopilotConversation,
  listConversationsForUser,
  listCopilotMessages,
  updateConversationTitle,
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

export const regenerateCopilotMessageController = async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const userMsgId = Number((req as any).params.userMsgId);
  try {
    const result = await startCopilotRegenerate({ userId, userMsgId, locale: detectLocale(req) });
    res.status(200).json({ data: { runId: result.runId, conversationId: result.conversationId } });
  } catch (err: any) {
    const status = err?.statusCode ?? 500;
    const message = err?.message ?? "The service is unavailable right now.";
    res.status(status).json({ error: { message } });
  }
};

export const listConversationsController = async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const conversations = await listConversationsForUser(userId);
  res.status(200).json({ data: conversations });
};

export const createConversationController = async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const locale = detectLocale(req);
  const conv = await createConversation(userId, locale);
  res.status(200).json({ data: { id: conv.id, conversationId: conv.id } });
};

export const updateConversationTitleController = async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const id = Number((req as any).params.id);
  const title = String((req as any).body?.title ?? "");
  try {
    await updateConversationTitle(id, userId, title);
    res.status(200).json({ data: { id } });
  } catch (err: any) {
    const status = err?.statusCode ?? 500;
    const message = err?.message ?? "Conversation not found";
    res.status(status).json({ error: { message } });
  }
};

export const deleteConversationController = async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const id = Number((req as any).params.id);
  try {
    await deleteConversation(id, userId);
    res.status(204).end();
  } catch (err: any) {
    const status = err?.statusCode ?? 500;
    const message = err?.message ?? "Conversation not found";
    res.status(status).json({ error: { message } });
  }
};
