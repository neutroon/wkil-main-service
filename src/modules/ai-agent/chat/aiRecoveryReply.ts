import { generateContent } from "@modules/ai-agent/gemini";
import { logger } from "@utils/logger";

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
};

function stripJsonOrMarkdown(text: string): string {
  return text
    .replace(/^```(?:json|text)?/i, "")
    .replace(/```$/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

function isSafeRecoveryReply(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > MAX_RECOVERY_CHARS) return false;
  if (UNSAFE_RECOVERY_PATTERN.test(trimmed)) return false;
  return true;
}

export async function generateSafeRecoveryReply({
  systemInstruction,
  channel,
  customerMessage,
  failureReason,
  safeFallback,
}: RecoveryReplyParams): Promise<string> {
  const prompt = [
    systemInstruction,
    "",
    "<recovery_task>",
    "Write ONE short customer-facing recovery reply.",
    "Match the business language, dialect, tone, and channel formatting rules above.",
    "The backend could not safely verify or complete the requested action.",
    `Failure reason code: ${failureReason}`,
    customerMessage ? `Customer message: ${customerMessage}` : "",
    channel ? `Channel: ${channel}` : "",
    "",
    "Hard safety rules:",
    "- Do not mention APIs, webhooks, CRM, tools, databases, internal errors, or technical details.",
    "- Do not claim anything was confirmed, booked, saved, sent, created, delivered, or submitted.",
    "- Do not invent facts, prices, availability, policies, contact details, or identifiers.",
    "- If information is missing or verification failed, ask for corrected details or say the team will confirm.",
    "- Keep it concise: 1-2 short sentences, plain text only.",
    "</recovery_task>",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const result = await Promise.race([
      generateContent(prompt, undefined, false, undefined, 0.2),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("AI_RECOVERY_TIMEOUT")), RECOVERY_TIMEOUT_MS),
      ),
    ]);

    const text = stripJsonOrMarkdown(result.text || "");
    if (isSafeRecoveryReply(text)) return text;

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
