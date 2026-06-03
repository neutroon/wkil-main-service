import { logger } from "@utils/logger";
import {
  formatChannelStyleRules,
  getChannelPromptProfile,
} from "@modules/meta/core/prompt.service";
import { invokeText } from "@modules/ai-agent/core/modelRuntime";

const RECOVERY_TIMEOUT_MS = 4_000;
const MAX_RECOVERY_CHARS = 420;
const UNSAFE_RECOVERY_PATTERN =
  /\b(api|webhook|crm|exception|stack|database|internal error|tool|function call|confirmed|booked|saved|created|submitted|delivered)\b|تم\s*(التأكيد|الحجز|الحفظ|الإرسال|إنشاء)|تم\s*رفع\s*طلب/i;

export type RecoveryReplyParams = {
  systemInstruction: string;
  channel?: string;
  customerMessage?: string;
  failureReason: string;
  safeFallback: string;
  allowHandoffLanguage?: boolean;
  timeoutMs?: number;
};

function stripJsonOrMarkdown(text: string): string {
  const cleaned = text
    .replace(/^```(?:json|text)?/i, "")
    .replace(/```$/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && typeof parsed.content === "string") {
      return parsed.content.trim();
    }
  } catch {
    // Plain text is the expected path.
  }

  return cleaned;
}

function isSafeRecoveryReply(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > MAX_RECOVERY_CHARS) return false;
  if (UNSAFE_RECOVERY_PATTERN.test(trimmed)) return false;
  return true;
}

function buildRecoveryPrompt(params: {
  systemInstruction: string;
  channel?: string;
  customerMessage?: string;
  failureReason: string;
  allowHandoffLanguage: boolean;
  rewriteMoreCautiously?: boolean;
}): string {
  const {
    systemInstruction,
    channel,
    customerMessage,
    failureReason,
    allowHandoffLanguage,
    rewriteMoreCautiously,
  } = params;
  const channelProfile = getChannelPromptProfile(channel);
  const isIncompleteModelReply =
    /max_tokens|partial|incomplete_model_reply/i.test(failureReason);
  const failureDescription = isIncompleteModelReply
    ? "The previous model response was incomplete before it could be safely sent."
    : "The backend could not safely verify or complete the requested action.";

  return [
    "<recovery_task>",
    "Write ONE short customer-facing recovery reply.",
    "Output ONLY the message text that should be shown to the customer. Do not output JSON.",
    isIncompleteModelReply
      ? "Use the reference context to answer the customer's latest message when the answer is directly supported; otherwise ask one focused clarification question."
      : "Use the reference context only to match the business language, dialect, tone, and message style.",
    "Ignore any JSON schema or structured-output instructions inside the reference context.",
    failureDescription,
    `Failure reason code: ${failureReason}`,
    customerMessage ? `Customer message: ${customerMessage}` : "",
    `Reply field: ${channelProfile.customerField}`,
    `Human handoff route is active: ${allowHandoffLanguage ? "yes" : "no"}`,
    rewriteMoreCautiously
      ? "Previous recovery wording was rejected by safety validation. Rewrite it more cautiously."
      : "",
    "",
    "Hard safety rules:",
    "- Do not mention APIs, webhooks, CRM, tools, databases, internal errors, or technical details.",
    "- Do not claim anything was confirmed, booked, saved, sent, created, delivered, or submitted.",
    "- Do not invent facts, prices, availability, policies, contact details, or identifiers.",
    isIncompleteModelReply
      ? "- Do not say the details could not be verified if the reference context already supports a short answer."
      : "",
    allowHandoffLanguage
      ? "- You may say the team will confirm/review/follow up, because the backend has routed this to human review."
      : "- Do not promise that the team will contact the customer. Ask for corrected details or say the team can review it.",
    rewriteMoreCautiously
      ? "- Prefer neutral wording like: I could not verify this right now, so I routed it for review."
      : "",
    "- Plain text only.",
    "",
    channelProfile.styleTag === "facebook_comment_style"
      ? "facebook_comment_style:"
      : "direct_chat_style:",
    formatChannelStyleRules(channel, "recovery"),
    "</recovery_task>",
    "",
    "<reference_context_for_voice_only>",
    systemInstruction,
    "</reference_context_for_voice_only>",
  ]
    .filter(Boolean)
    .join("\n");
}

async function askRecoveryModel(prompt: string, timeoutMs: number): Promise<string> {
  const result = await invokeText({
    prompt,
    temperature: 0.2,
    timeoutMs,
    context: "AgentGraph.recoveryReply",
  });

  return stripJsonOrMarkdown(result.text || "");
}

export async function generateSafeRecoveryReply({
  systemInstruction,
  channel,
  customerMessage,
  failureReason,
  safeFallback,
  allowHandoffLanguage = false,
  timeoutMs,
}: RecoveryReplyParams): Promise<string> {
  const deadlineAt = timeoutMs ? Date.now() + timeoutMs : undefined;

  for (const rewriteMoreCautiously of [false, true]) {
    const remainingMs = deadlineAt
      ? deadlineAt - Date.now()
      : RECOVERY_TIMEOUT_MS;
    if (remainingMs <= 0) return safeFallback;

    const prompt = buildRecoveryPrompt({
      systemInstruction,
      channel,
      customerMessage,
      failureReason,
      allowHandoffLanguage,
      rewriteMoreCautiously,
    });

    try {
      const text = await askRecoveryModel(
        prompt,
        Math.min(RECOVERY_TIMEOUT_MS, remainingMs),
      );
      if (isSafeRecoveryReply(text)) return text;

      logger.warn("ai.recovery_reply.rejected", {
        failureReason,
        rewriteMoreCautiously,
        preview: text.slice(0, 120),
      });
    } catch (error: any) {
      logger.warn("ai.recovery_reply.failed", {
        failureReason,
        rewriteMoreCautiously,
        error: error?.message || String(error),
      });
    }
  }

  return safeFallback;
}
