import { logger } from "@utils/logger";
import { invokeExternalToolRecoveryRoute } from "@modules/ai-agent/core/modelRuntime";

const RECOVERY_CLASSIFIER_TIMEOUT_MS = 2_000;

export type ExternalToolRecoveryRoute = "normal_reply" | "handoff";

function buildRecoveryClassifierPrompt(params: {
  customerMessage: string;
  failureReason: string;
}): string {
  return [
    "You are a strict router for failed chat-requested external actions in a customer-support chat.",
    "Return ONLY compact JSON with this exact shape: {\"route\":\"normal_reply\"|\"handoff\",\"reasoning\":\"short reason\"}.",
    "",
    "Choose normal_reply when the failed Agent Action was not essential to answer the latest user message, such as greetings, small talk, thanks, broad business/context questions, or generic support that should be handled without action results.",
    "Choose handoff when the user explicitly needed the failed Agent Action, such as account/order/status/booking/availability/price/customer-specific verification, or when it is unsafe to answer without the action result.",
    "If uncertain, choose handoff.",
    "",
    `Latest user message: ${JSON.stringify(params.customerMessage)}`,
    `Failure reason: ${JSON.stringify(params.failureReason)}`,
  ].join("\n");
}

export async function classifyExternalToolFailureRecovery(params: {
  customerMessage: string;
  failureReason: string;
}): Promise<ExternalToolRecoveryRoute> {
  try {
    const result = await invokeExternalToolRecoveryRoute({
      prompt: buildRecoveryClassifierPrompt(params),
      timeoutMs: RECOVERY_CLASSIFIER_TIMEOUT_MS,
    });
    return result.route;
  } catch (error: any) {
    logger.warn("ai.external_tool_recovery_classifier.failed", {
      error: error?.message || String(error),
    });
  }

  return "handoff";
}
