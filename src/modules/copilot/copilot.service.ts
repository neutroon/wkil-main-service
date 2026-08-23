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

const ERROR_TEXT: Record<"ar" | "en", string> = {
  ar: "الخدمة مش متاحة دلوقتي، جرب تاني بعد شوية.",
  en: "The service is unavailable right now — please try again shortly.",
};

export async function runCopilotTurn(params: {
  userId: number;
  text: string;
  locale: "ar" | "en";
  conversationId?: number;
}): Promise<{ conversationId: number; envelopes: CopilotEnvelope[] }> {
  const conv = params.conversationId
    ? await getCopilotConversationForUser(params.conversationId, params.userId)
    : await getOrCreateCopilotConversation(params.userId, params.locale);

  await assertQuotaAvailable(params.userId, undefined);
  await appendCopilotMessage({
    conversationId: conv.id,
    role: "USER",
    envelope: { type: "text", text: params.text },
  });

  let envelopes: CopilotEnvelope[];
  try {
    const out = await runCopilotGraph({
      conversationId: conv.id,
      userId: params.userId,
      locale: params.locale,
      text: params.text,
    });
    envelopes = out.envelopes;
    await recordAiUsage({
      userId: params.userId,
      modelName: out.modelName,
      operation: "copilot_chat",
      conversationId: String(conv.id),
      promptTokens: out.usage.promptTokens,
      completionTokens: out.usage.completionTokens,
    });
  } catch (error: any) {
    logger.error("copilot.turn_failed", { conversationId: conv.id, error: error?.message });
    envelopes = [{ type: "error", message: ERROR_TEXT[params.locale], retryable: true }];
  }

  await appendCopilotMessage({
    conversationId: conv.id,
    role: "ASSISTANT",
    envelope: { envelopes },
  });
  emitToCopilot(params.userId, "copilot:message", { conversationId: conv.id, envelopes });
  return { conversationId: conv.id, envelopes };
}
