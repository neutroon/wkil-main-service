import type { AiRoutingDecision } from "@modules/ai-agent/core/aiEngine.utils";

type SavedModelMessage = {
  id: number;
  handoffCategory?: string | null;
};

type ReplySideEffectInput = {
  businessProfileId: number;
  conversationId: number;
  message: SavedModelMessage;
  reply: Pick<
    AiRoutingDecision,
    "action" | "handoffCategory" | "reasoning"
  > & Partial<Pick<AiRoutingDecision, "replyType" | "missingInfo">>;
};

export async function notifySavedModelReplySideEffects(
  params: ReplySideEffectInput,
) {
  if (isCustomerHandoff(params.reply)) {
    const { syncHandoffRequested } = await import(
      "@modules/realtime/socketSync.service"
    );
    syncHandoffRequested({
      businessProfileId: params.businessProfileId,
      conversationId: params.conversationId,
      message: params.message,
    });
  }

  if (isSystemErrorReply(params.reply)) {
    const { syncSystemError } = await import(
      "@modules/realtime/socketSync.service"
    );
    syncSystemError({
      businessProfileId: params.businessProfileId,
      conversationId: params.conversationId,
      reason: params.reply.reasoning || "AI system error",
    });
  }
}

export function shouldScheduleFollowUpsForSavedReply(
  params: ReplySideEffectInput,
): boolean {
  if (isSystemErrorReply(params.reply)) return false;
  if (isCustomerHandoff(params.reply)) return false;
  if (isWaitingForCustomerInput(params.reply)) return false;
  if (params.message.handoffCategory) return false;
  return true;
}

export async function scheduleFollowUpsForDeliveredReply(
  params: ReplySideEffectInput,
) {
  if (!shouldScheduleFollowUpsForSavedReply(params)) return;

  const { scheduleConversationFollowUps } = await import(
    "@modules/follow-up/followUp.service"
  );
  await scheduleConversationFollowUps({
    conversationId: params.conversationId,
    businessProfileId: params.businessProfileId,
    triggerMessageId: params.message.id,
  });
}

export async function runSavedModelReplySideEffects(
  params: ReplySideEffectInput & { scheduleFollowUps?: boolean },
) {
  await notifySavedModelReplySideEffects(params);
  if (params.scheduleFollowUps) {
    await scheduleFollowUpsForDeliveredReply(params);
  }
}

function isCustomerHandoff(
  reply: Pick<AiRoutingDecision, "action" | "handoffCategory">,
): boolean {
  return (
    reply.action === "HANDOFF_TO_HUMAN" &&
    Boolean(reply.handoffCategory) &&
    reply.handoffCategory !== "SYSTEM_ERROR"
  );
}

function isSystemErrorReply(
  reply: Pick<AiRoutingDecision, "handoffCategory">,
): boolean {
  return reply.handoffCategory === "SYSTEM_ERROR";
}

function isWaitingForCustomerInput(
  reply: Partial<Pick<AiRoutingDecision, "replyType" | "missingInfo">>,
): boolean {
  const replyType = String(reply.replyType || "").toUpperCase();
  if (replyType === "CLARIFICATION" || replyType === "ASK_FOR_CORRECTION") {
    return true;
  }
  return Boolean(reply.missingInfo);
}
