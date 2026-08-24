import { randomUUID } from "node:crypto";
import { logger } from "@utils/logger";
import { AppError } from "@middlewares/errorHandler.middleware";
import { assertQuotaAvailable, recordAiUsage } from "@modules/billing/billing.service";
import { emitToCopilot } from "@modules/realtime/socket";
import { runCopilotGraph } from "./copilot.graph";
import {
  appendCopilotMessage,
  deleteCopilotMessagesAfter,
  getCopilotConversationForUser,
  getCopilotMessageById,
  getOrCreateCopilotConversation,
  listCopilotMessages,
  updateConversationTitle,
} from "./copilot.store";
import type { CopilotEnvelope } from "./copilot.types";

export type ActiveRun = {
  abortController: AbortController;
  conversationId: number;
  userId: number;
};

export const activeRuns = new Map<string, ActiveRun>();

function maybeAutoTitle(
  conversationId: number,
  userId: number,
  currentTitle: string | null | undefined,
): void {
  if (currentTitle) return;
  void (async () => {
    try {
      const recent = await listCopilotMessages(conversationId, 50);
      const firstUser = recent.find((m) => m.role === "USER");
      if (firstUser && (firstUser.envelope as any)?.type === "text") {
        const fullText = (firstUser.envelope as any).text as string;
        const truncated = fullText.length > 50 ? `${fullText.slice(0, 50)}…` : fullText;
        await updateConversationTitle(conversationId, userId, truncated);
      }
    } catch {
      // ignore — auto-title is best-effort
    }
  })();
}

export async function cancelCopilotRun(
  runId: string,
  userId: number,
): Promise<{ cancelled: boolean }> {
  const run = activeRuns.get(runId);
  if (!run) return { cancelled: false };
  if (run.userId !== userId) return { cancelled: false };
  run.abortController.abort();
  activeRuns.delete(runId);
  return { cancelled: true };
}

export async function startCopilotTurn(params: {
  userId: number;
  text: string;
  locale: "ar" | "en";
  conversationId?: number;
}): Promise<{ runId: string; conversationId: number }> {
  const conv = params.conversationId
    ? await getCopilotConversationForUser(params.conversationId, params.userId)
    : await getOrCreateCopilotConversation(params.userId, params.locale);

  await assertQuotaAvailable(params.userId, undefined);
  await appendCopilotMessage({
    conversationId: conv.id,
    role: "USER",
    envelope: { type: "text", text: params.text },
  });

  const runId = randomUUID();
  const abortController = new AbortController();
  activeRuns.set(runId, {
    abortController,
    conversationId: conv.id,
    userId: params.userId,
  });

  // Fire-and-forget. Errors are caught inside the background runner.
  void runCopilotTurnInBackground(runId, params, conv, abortController.signal);

  return { runId, conversationId: conv.id };
}

async function runCopilotTurnInBackground(
  runId: string,
  params: { userId: number; text: string; locale: "ar" | "en"; conversationId?: number },
  conv: { id: number; title: string | null },
  signal: AbortSignal,
): Promise<void> {
  try {
    const out = await runCopilotGraph({
      conversationId: conv.id,
      userId: params.userId,
      locale: params.locale,
      text: params.text,
      signal,
    });

    await recordAiUsage({
      userId: params.userId,
      modelName: out.modelName,
      operation: "copilot_chat",
      conversationId: String(conv.id),
      promptTokens: out.usage.promptTokens,
      completionTokens: out.usage.completionTokens,
    });

    await appendCopilotMessage({
      conversationId: conv.id,
      role: "ASSISTANT",
      envelope: {
        envelopes: out.envelopes,
        truncated: out.truncated,
        ...(out.expectedTotal !== null ? { expectedTotal: out.expectedTotal } : {}),
      },
    });
    emitToCopilot(params.userId, "copilot:message", {
      runId,
      conversationId: conv.id,
      envelopes: out.envelopes,
      truncated: out.truncated,
      ...(out.expectedTotal !== null ? { expectedTotal: out.expectedTotal } : {}),
    });

    // Auto-title: set a short summary from the first user message on first assistant response.
    // Fire-and-forget — don't block the response.
    maybeAutoTitle(conv.id, params.userId, conv.title);
  } catch (error: any) {
    if (error?.name === "AbortError" || signal.aborted) {
      emitToCopilot(params.userId, "copilot:cancelled", {
        runId,
        conversationId: conv.id,
      });
    } else {
      logger.error("copilot.turn_failed", {
        conversationId: conv.id,
        runId,
        error: error?.message,
      });
      emitToCopilot(params.userId, "copilot:error", {
        runId,
        conversationId: conv.id,
        message: "The service is unavailable right now.",
      });
    }
  } finally {
    activeRuns.delete(runId);
  }
}

export type RegenerateParams = {
  userId: number;
  userMsgId: number;
  locale: "ar" | "en";
};

export async function startCopilotRegenerate(
  params: RegenerateParams,
): Promise<{ runId: string; conversationId: number }> {
  const parent = await getCopilotMessageById(params.userMsgId, params.userId);
  if (!parent) throw new AppError("parent message not found", 404, false);
  if (parent.role !== "USER") {
    throw new AppError("parent must be a user message", 422, false);
  }

  // Verify there's an assistant response to regenerate.
  const children = await listCopilotMessages(parent.conversationId, 50);
  const hasAssistant = children.some(
    (m) =>
      m.role === "ASSISTANT" &&
      new Date(m.createdAt) >= new Date(parent.createdAt),
  );
  if (!hasAssistant) {
    throw new AppError("no assistant response to regenerate", 422, false);
  }

  // Delete messages after the parent (including original assistant + later turns).
  await deleteCopilotMessagesAfter(parent.conversationId, params.userMsgId, params.userId);

  // Register the new runId + kick off background runner.
  const runId = randomUUID();
  const abortController = new AbortController();
  activeRuns.set(runId, {
    abortController,
    conversationId: parent.conversationId,
    userId: params.userId,
  });

  // Fire-and-forget.
  void runCopilotRegenerateBackground(runId, params, parent, abortController.signal);

  return { runId, conversationId: parent.conversationId };
}

async function runCopilotRegenerateBackground(
  runId: string,
  params: RegenerateParams,
  parent: NonNullable<Awaited<ReturnType<typeof getCopilotMessageById>>>,
  signal: AbortSignal,
): Promise<void> {
  try {
    const envelope = parent.envelope as { type: "text"; text: string };
    const conv = await getCopilotConversationForUser(parent.conversationId, params.userId);
    const out = await runCopilotGraph({
      conversationId: parent.conversationId,
      userId: params.userId,
      locale: params.locale,
      text: envelope.text,
      signal,
    });

    await recordAiUsage({
      userId: params.userId,
      modelName: out.modelName,
      operation: "copilot_chat",
      conversationId: String(parent.conversationId),
      promptTokens: out.usage.promptTokens,
      completionTokens: out.usage.completionTokens,
    });

    await appendCopilotMessage({
      conversationId: parent.conversationId,
      role: "ASSISTANT",
      envelope: {
        envelopes: out.envelopes,
        truncated: out.truncated,
        ...(out.expectedTotal !== null ? { expectedTotal: out.expectedTotal } : {}),
      },
    });
    emitToCopilot(params.userId, "copilot:message", {
      runId,
      conversationId: parent.conversationId,
      envelopes: out.envelopes,
      truncated: out.truncated,
      ...(out.expectedTotal !== null ? { expectedTotal: out.expectedTotal } : {}),
    });

    // Auto-title: set a short summary from the first user message on first assistant response.
    // Fire-and-forget — don't block the response.
    if (conv && !conv.title) {
      maybeAutoTitle(parent.conversationId, params.userId, conv.title);
    }
  } catch (error: any) {
    if (error?.name === "AbortError" || signal.aborted) {
      emitToCopilot(params.userId, "copilot:cancelled", {
        runId,
        conversationId: parent.conversationId,
      });
    } else {
      logger.error("copilot.regenerate_failed", {
        parentId: params.userMsgId,
        runId,
        error: error?.message,
      });
      emitToCopilot(params.userId, "copilot:error", {
        runId,
        conversationId: parent.conversationId,
        message: "The service is unavailable right now.",
      });
    }
  } finally {
    activeRuns.delete(runId);
  }
}
