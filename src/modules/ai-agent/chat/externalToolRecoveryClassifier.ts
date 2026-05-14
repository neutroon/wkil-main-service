import { generateContent } from "@modules/ai-agent/gemini";
import { logger } from "@utils/logger";

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

function parseRoute(text: string): ExternalToolRecoveryRoute | null {
  const cleaned = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return parsed?.route === "normal_reply" || parsed?.route === "handoff"
      ? parsed.route
      : null;
  } catch {
    return null;
  }
}

export async function classifyExternalToolFailureRecovery(params: {
  customerMessage: string;
  failureReason: string;
}): Promise<ExternalToolRecoveryRoute> {
  try {
    const result = await Promise.race([
      generateContent(buildRecoveryClassifierPrompt(params), undefined, false, undefined, 0),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("EXTERNAL_TOOL_RECOVERY_CLASSIFIER_TIMEOUT")),
          RECOVERY_CLASSIFIER_TIMEOUT_MS,
        ),
      ),
    ]);

    const route = parseRoute(result.text || "");
    if (route) return route;

    logger.warn("ai.external_tool_recovery_classifier.invalid_output", {
      preview: (result.text || "").slice(0, 120),
    });
  } catch (error: any) {
    logger.warn("ai.external_tool_recovery_classifier.failed", {
      error: error?.message || String(error),
    });
  }

  return "handoff";
}
