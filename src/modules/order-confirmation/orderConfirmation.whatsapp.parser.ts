type RecordValue = Record<string, unknown>;

const OPT_OUT_PHRASES = new Set([
  "stop",
  "unsubscribe",
  "stop all",
  "unsubscribe me",
  "do not message",
  "don t message",
  "وقف",
  "وقف الرسائل",
  "لا تراسل",
  "الغاء",
  "إلغاء",
  "الغاء الاشتراك",
  "إلغاء الاشتراك",
]);

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}

export function parseWhatsAppInteractiveReply(
  message: unknown,
): { actionToken: string; buttonTitle?: string } | null {
  if (!isRecord(message) || !isRecord(message.interactive)) return null;

  const buttonReply = message.interactive.button_reply;
  if (!isRecord(buttonReply) || typeof buttonReply.id !== "string") return null;
  if (buttonReply.id.trim().length === 0) return null;

  const result: { actionToken: string; buttonTitle?: string } = {
    actionToken: buttonReply.id,
  };
  if (typeof buttonReply.title === "string" && buttonReply.title.trim().length > 0) {
    result.buttonTitle = buttonReply.title;
  }

  return result;
}

export function normalizeOptOutText(text: string): string {
  if (typeof text !== "string") return "";

  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function isWhatsAppOptOut(text: string): boolean {
  return OPT_OUT_PHRASES.has(normalizeOptOutText(text));
}
