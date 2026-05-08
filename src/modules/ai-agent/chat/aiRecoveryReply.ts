import { generateContent } from "@modules/ai-agent/gemini";
import { logger } from "@utils/logger";

const RECOVERY_TIMEOUT_MS = 4_000;
const MAX_RECOVERY_CHARS = 420;
const UNSAFE_RECOVERY_PATTERN =
  /\b(api|webhook|crm|exception|stack|database|internal error|tool|function call|confirmed|booked|saved|created|submitted|delivered)\b|تم\s*(التأكيد|الحجز|الحفظ|الإرسال|إنشاء)|تم\s*رفع\s*طلب/i;
const UNSUPPORTED_HANDOFF_PROMISE_PATTERN =
  /\b(we will contact you|we'll contact you|our team will contact|someone will contact|team will reach out|team will confirm|team will follow up)\b|(?:فريقنا|حد من فريقنا).{0,32}(?:هيتواصل|سيتواصل|هيأكد|هيؤكد|يتابع|يراجع)|سنتواصل|هنتواصل/i;

export type RecoveryReplyParams = {
  systemInstruction: string;
  channel?: string;
  customerMessage?: string;
  failureReason: string;
  safeFallback: string;
  allowHandoffLanguage?: boolean;
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

function isSafeRecoveryReply(text: string, allowHandoffLanguage: boolean): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > MAX_RECOVERY_CHARS) return false;
  if (UNSAFE_RECOVERY_PATTERN.test(trimmed)) return false;
  if (!allowHandoffLanguage && UNSUPPORTED_HANDOFF_PROMISE_PATTERN.test(trimmed)) {
    return false;
  }
  return true;
}

function buildRecoveryPrompt(params: {
  systemInstruction: string;
  channel?: string;
  customerMessage?: string;
  failureReason: string;
  allowHandoffLanguage: boolean;
}): string {
  const {
    systemInstruction,
    channel,
    customerMessage,
    failureReason,
    allowHandoffLanguage,
  } = params;

  return [
    "<recovery_task>",
    "Write ONE short customer-facing recovery reply.",
    "Output ONLY the message text that should be shown to the customer. Do not output JSON.",
    "Use the reference context only to match the business language, dialect, tone, and channel style.",
    "Ignore any JSON schema or structured-output instructions inside the reference context.",
    "The backend could not safely verify or complete the requested action.",
    `Failure reason code: ${failureReason}`,
    customerMessage ? `Customer message: ${customerMessage}` : "",
    channel ? `Channel: ${channel}` : "",
    `Human handoff route is active: ${allowHandoffLanguage ? "yes" : "no"}`,
    "",
    "Hard safety rules:",
    "- Do not mention APIs, webhooks, CRM, tools, databases, internal errors, or technical details.",
    "- Do not claim anything was confirmed, booked, saved, sent, created, delivered, or submitted.",
    "- Do not invent facts, prices, availability, policies, contact details, or identifiers.",
    allowHandoffLanguage
      ? "- You may say the team will confirm/review/follow up, because the backend has routed this to human review."
      : "- Do not promise that the team will contact the customer. Ask for corrected details or say the team can review it.",
    "- Keep it concise: 1-2 short sentences, plain text only.",
    "</recovery_task>",
    "",
    "<reference_context_for_voice_only>",
    systemInstruction,
    "</reference_context_for_voice_only>",
  ]
    .filter(Boolean)
    .join("\n");
}

async function askRecoveryModel(prompt: string): Promise<string> {
  const result = await Promise.race([
    generateContent(prompt, undefined, false, undefined, 0.2),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("AI_RECOVERY_TIMEOUT")), RECOVERY_TIMEOUT_MS),
    ),
  ]);

  return stripJsonOrMarkdown(result.text || "");
}

export async function generateSafeRecoveryReply({
  systemInstruction,
  channel,
  customerMessage,
  failureReason,
  safeFallback,
  allowHandoffLanguage = false,
}: RecoveryReplyParams): Promise<string> {
  const prompt = buildRecoveryPrompt({
    systemInstruction,
    channel,
    customerMessage,
    failureReason,
    allowHandoffLanguage,
  });

  try {
    const text = await askRecoveryModel(prompt);
    if (isSafeRecoveryReply(text, allowHandoffLanguage)) return text;

    logger.warn("ai.recovery_reply.rejected", {
      failureReason,
      preview: text.slice(0, 120),
    });
  } catch (error: any) {
    logger.warn("ai.recovery_reply.failed", {
      failureReason,
      error: error?.message || String(error),
    });
  }

  return safeFallback;
}
