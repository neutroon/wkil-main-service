export type InboundMediaInfo = {
  id?: string | null;
  type?: string | null;
  url?: string | null;
  metadata?: unknown;
};

export type InboundMessageSignal = {
  shouldTriggerAi: boolean;
  reason?: "passive_reaction" | "passive_sticker" | "empty_message";
};

const PASSIVE_MEDIA_TYPES = new Set(["reaction", "like", "sticker"]);

function metadataObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function hasMeaningfulMediaMetadata(value: unknown): boolean {
  const metadata = metadataObject(value);
  return Object.values(metadata).some((entry) => {
    if (entry === null || entry === undefined || entry === "") return false;
    if (Array.isArray(entry)) return entry.length > 0;
    if (typeof entry === "object") return Object.keys(entry).length > 0;
    return true;
  });
}

function normalizeMediaType(type?: string | null): string {
  return String(type || "text").trim().toLowerCase();
}

function compactText(text?: string | null): string {
  return String(text || "").trim();
}

export function isEmojiOnlyText(text?: string | null): boolean {
  const trimmed = compactText(text);
  if (!trimmed) return false;
  if (/[\p{L}\p{N}]/u.test(trimmed)) return false;

  const punctuationStripped = trimmed.replace(/[\s.,!?؟،؛:'"()[\]{}<>/\\|+*=~_-]/g, "");
  if (!punctuationStripped) return false;

  return /^[\p{Emoji}\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D]+$/u.test(
    punctuationStripped,
  );
}

export function classifyInboundMessageSignal(params: {
  type?: string | null;
  messageText?: string | null;
  mediaId?: string | null;
  mediaMetadata?: unknown;
}): InboundMessageSignal {
  const type = normalizeMediaType(params.type);
  const metadata = metadataObject(params.mediaMetadata);

  if (type === "reaction" || metadata.isReaction === true) {
    return { shouldTriggerAi: false, reason: "passive_reaction" };
  }

  if (
    type === "sticker" ||
    metadata.isSticker === true ||
    (metadata.stickerId && !params.messageText)
  ) {
    return { shouldTriggerAi: false, reason: "passive_sticker" };
  }

  if (PASSIVE_MEDIA_TYPES.has(type)) {
    return { shouldTriggerAi: false, reason: "passive_reaction" };
  }

  if (!compactText(params.messageText) && !params.mediaId) {
    return { shouldTriggerAi: false, reason: "empty_message" };
  }

  return { shouldTriggerAi: true };
}

function formatMediaSize(bytes: unknown): string | null {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value < 1024) return `${value} bytes`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function mediaAnalysisText(mediaMetadata?: unknown): string | null {
  const metadata = metadataObject(mediaMetadata);
  const analysis = metadata.analysis;
  if (!analysis || typeof analysis !== "object") return null;

  const candidates = [
    (analysis as any).text,
    (analysis as any).summary,
    (analysis as any).transcript,
    (analysis as any).ocrText,
    (analysis as any).description,
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  const status = String((analysis as any).status || "").trim();
  if (status && status !== "completed") return `Media analysis status: ${status}.`;
  return null;
}

export function mediaTurnPromptText(params: {
  content?: string | null;
  type?: string | null;
  mediaId?: string | null;
  mediaMetadata?: unknown;
}): string {
  const metadata = metadataObject(params.mediaMetadata);
  const type = normalizeMediaType(params.type);
  const caption = compactText(params.content);
  const details = [
    typeof metadata.filename === "string" ? `filename: ${metadata.filename}` : null,
    typeof metadata.title === "string" ? `title: ${metadata.title}` : null,
    typeof metadata.mimeType === "string" ? `mime type: ${metadata.mimeType}` : null,
    formatMediaSize(metadata.size),
    typeof metadata.duration === "number" ? `duration: ${metadata.duration}s` : null,
  ].filter(Boolean);

  const lines = [
    caption ? `Customer message/caption: ${caption}` : null,
    `[Customer sent ${type} attachment${details.length ? ` (${details.join(", ")})` : ""}.]`,
  ];

  const analysis = mediaAnalysisText(metadata);
  if (analysis) lines.push(`Media understanding: ${analysis}`);

  return lines.filter(Boolean).join("\n");
}

export function customerMessageForModel(params: {
  messageText?: string | null;
  mediaInfo?: InboundMediaInfo | null;
}): string {
  const text = compactText(params.messageText);
  const mediaInfo = params.mediaInfo;

  if (
    mediaInfo?.id ||
    hasMeaningfulMediaMetadata(mediaInfo?.metadata)
  ) {
    return mediaTurnPromptText({
      content: text,
      type: mediaInfo?.type,
      mediaId: mediaInfo?.id,
      mediaMetadata: mediaInfo?.metadata,
    });
  }

  if (isEmojiOnlyText(text)) {
    return `[Customer sent emoji-only text: ${text}]`;
  }

  return text;
}
