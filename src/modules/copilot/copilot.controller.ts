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

/**
 * Detect the owner's UI locale for the copilot.
 *
 * Priority:
 *  1. Explicit `X-Locale` header from the frontend. The Next.js app sets this
 *     from `useLocale()` on every request so the copilot always matches the
 *     UI language — independent of the browser's `Accept-Language`. This
 *     matters because the dashboard is bilingual (ar/en) but the user's
 *     browser may be set to a different default.
 *  2. `Accept-Language` header (browser default). Covers the case where the
 *     client doesn't set `X-Locale` (e.g. third-party callers).
 *  3. English (defensive fallback for completely missing/garbage input).
 *
 * Whitespace and casing are normalized; the response is restricted to the
 * two locales the copilot supports.
 */
export function detectLocale(req: Request): "ar" | "en" {
  const xLocale = (req.headers["x-locale"] as string | undefined)?.toLowerCase().trim();
  if (xLocale === "ar") return "ar";
  if (xLocale === "en") return "en";

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
  const requestedConversationId = ((req.query as any).conversationId as number | undefined);
  // When the caller passes a conversationId, look up that specific thread
  // (ownership-checked via `getCopilotConversationForUser`); otherwise fall
  // back to the legacy "current primary conversation" semantics so the
  // single-thread frontend flow continues to work.
  const conv = requestedConversationId !== undefined
    ? await getCopilotConversationForUser(requestedConversationId, userId)
    : await getOrCreateCopilotConversation(userId, detectLocale(req));
  const messages = await listCopilotMessages(conv.id, limit);
  res.status(200).json({ data: messages });
};

export const postCopilotMessageController = async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  // The frontend posts to a specific thread it has already created (either
  // a synced remote id, or one it just created in response to a local
  // `__LOCALID_xxx` placeholder). We MUST forward `conversationId` to
  // `startCopilotTurn` — otherwise the service falls through to
  // `getOrCreateCopilotConversation` (the user's most-recent existing
  // thread) and the message silently lands in the wrong conversation.
  // The service's `getCopilotConversationForUser` enforces ownership, so
  // passing a foreign id is a safe 404.
  const { text, conversationId } = (req as any).body as {
    text: string;
    conversationId?: number;
  };
  const locale = detectLocale(req);
  const result = await startCopilotTurn({
    userId,
    text,
    locale,
    ...(typeof conversationId === "number" ? { conversationId } : {}),
  });
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
