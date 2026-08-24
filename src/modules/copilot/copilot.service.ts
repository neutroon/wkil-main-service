import { AppError } from "@middlewares/errorHandler.middleware";
import { logger } from "@utils/logger";
import { assertQuotaAvailable, recordAiUsage } from "@modules/billing/billing.service";
import { emitToCopilot } from "@modules/realtime/socket";
import { runCopilotGraph } from "./copilot.graph";
import {
  appendCopilotMessage,
  getCopilotConversationForUser,
  getOrCreateCopilotConversation,
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

export async function runCopilotTurn(params: {
  userId: number;
  text: string;
  locale: "ar" | "en";
  conversationId?: number;
}): Promise<CopilotTurnResult> {
  const conv = params.conversationId
    ? await getCopilotConversationForUser(params.conversationId, params.userId)
    : await getOrCreateCopilotConversation(params.userId, params.locale);

  await assertQuotaAvailable(params.userId, undefined);
  await appendCopilotMessage({
    conversationId: conv.id,
    role: "USER",
    envelope: { type: "text", text: params.text },
  });

  let out: Awaited<ReturnType<typeof runCopilotGraph>>;
  try {
    out = await runCopilotGraph({
      conversationId: conv.id,
      userId: params.userId,
      locale: params.locale,
      text: params.text,
    });
  } catch (error: any) {
    logger.error("copilot.turn_failed", { conversationId: conv.id, error: error?.message });
    return { ok: false, code: "GRAPH_FAILED", message: "The service is unavailable right now.", retryable: true };
  }

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
    conversationId: conv.id,
    envelopes: out.envelopes,
    truncated: out.truncated,
    ...(out.expectedTotal !== null ? { expectedTotal: out.expectedTotal } : {}),
  });
  return {
    ok: true,
    conversationId: conv.id,
    envelopes: out.envelopes,
    truncated: out.truncated,
    expectedTotal: out.expectedTotal,
  };
}
