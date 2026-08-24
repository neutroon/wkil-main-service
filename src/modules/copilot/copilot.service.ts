import { randomUUID } from "node:crypto";
import { AppError } from "@middlewares/errorHandler.middleware";
import { logger } from "@utils/logger";
import { assertQuotaAvailable, recordAiUsage } from "@modules/billing/billing.service";
import { emitToCopilot } from "@modules/realtime/socket";
import { runCopilotGraph } from "./copilot.graph";
import {
  appendCopilotMessage,
  getCopilotConversationForUser,
  getOrCreateCopilotConversation,
  listCopilotMessages,
} from "./copilot.store";
import type { CopilotEnvelope } from "./copilot.types";

export type CopilotTurnResult =
  | {
      ok: true;
      conversationId: number;
      envelopes: CopilotEnvelope[];
      truncated: boolean;
      expectedTotal: number | null;
    }
  | { ok: false; code: string; message: string; retryable: boolean };

export type ActiveRun = {
  abortController: AbortController;
  conversationId: number;
  userId: number;
};

export const activeRuns = new Map<string, ActiveRun>();

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
  conv: { id: number },
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

// DEPRECATED shim — kept so the existing controller (which expects the
// sync { ok, ... } result shape) continues to work until Task 3 rewires it
// to startCopilotTurn. Internally delegates to startCopilotTurn + waits for
// the background runner to finish, then reads the persisted assistant
// message from the store.
export async function runCopilotTurn(params: {
  userId: number;
  text: string;
  locale: "ar" | "en";
  conversationId?: number;
}): Promise<CopilotTurnResult> {
  let runId: string;
  let conversationId: number;
  try {
    const started = await startCopilotTurn(params);
    runId = started.runId;
    conversationId = started.conversationId;
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    throw err;
  }

  while (activeRuns.has(runId)) {
    await new Promise((r) => setTimeout(r, 5));
  }

  const messages = await listCopilotMessages(conversationId, 50);
  const lastAssistant = [...messages].reverse().find((m) => m.role === "ASSISTANT");
  if (!lastAssistant) {
    return {
      ok: false,
      code: "GRAPH_FAILED",
      message: "The service is unavailable right now.",
      retryable: true,
    };
  }
  const env = lastAssistant.envelope as any;
  return {
    ok: true,
    conversationId,
    envelopes: env.envelopes,
    truncated: env.truncated,
    expectedTotal: env.expectedTotal ?? null,
  };
}
