import { logger } from "@utils/logger";
import { invokeMediaUnderstanding } from "@modules/ai-agent/core/modelRuntime";
import { getMetaMediaUrl } from "./metaMedia.service";

const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

export type MediaUnderstandingResult = {
  status: "completed" | "unsupported" | "failed";
  text?: string;
  mimeType?: string;
  modelName?: string;
  finishReason?: string | null;
  errorCode?: string;
};

function metadataObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function headerObject(platform: "messenger" | "whatsapp", accessToken: string) {
  return platform === "whatsapp"
    ? { Authorization: `Bearer ${accessToken}` }
    : undefined;
}

async function fetchMediaBuffer(params: {
  platform: "messenger" | "whatsapp";
  accessToken: string;
  mediaId: string;
  fallbackUrl?: string;
}): Promise<{ buffer: Buffer; mimeType: string }> {
  const url =
    params.platform === "messenger" && params.fallbackUrl
      ? params.fallbackUrl
      : await getMetaMediaUrl(
          params.mediaId,
          params.accessToken,
          params.platform,
          params.fallbackUrl,
        );

  const response = await fetch(url, {
    headers: headerObject(params.platform, params.accessToken),
  } as any);
  if (!response.ok) {
    throw new Error(`media_fetch_${response.status}`);
  }

  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_MEDIA_BYTES) {
    throw new Error("media_too_large");
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_MEDIA_BYTES) {
    throw new Error("media_too_large");
  }

  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: response.headers.get("content-type") || "application/octet-stream",
  };
}

export async function understandInboundMedia(params: {
  platform: "messenger" | "whatsapp";
  accessToken: string;
  mediaId?: string | null;
  type?: string | null;
  mediaMetadata?: unknown;
}): Promise<MediaUnderstandingResult | null> {
  if (!params.mediaId) return null;

  const type = String(params.type || "").toLowerCase();
  const metadata = metadataObject(params.mediaMetadata);
  const declaredMimeType = String(metadata.mimeType || "");
  const isImage = type === "image" || declaredMimeType.startsWith("image/");

  if (!isImage) {
    return {
      status: "unsupported",
      mimeType: declaredMimeType || undefined,
      errorCode: "unsupported_media_type",
    };
  }

  try {
    const media = await fetchMediaBuffer({
      platform: params.platform,
      accessToken: params.accessToken,
      mediaId: params.mediaId,
      fallbackUrl: typeof metadata.url === "string" ? metadata.url : undefined,
    });

    if (!media.mimeType.startsWith("image/")) {
      return {
        status: "unsupported",
        mimeType: media.mimeType,
        errorCode: "unsupported_media_type",
      };
    }

    const result = await invokeMediaUnderstanding({
      prompt: [
        "Describe this customer-sent image for a customer support agent.",
        "Use one or two concise sentences.",
        "If the image contains readable text, include the important text.",
        "Do not invent prices, policies, availability, or contact details.",
      ].join("\n"),
      mimeType: media.mimeType,
      base64Data: media.buffer.toString("base64"),
      maxOutputTokens: 512,
      timeoutMs: 45_000,
    });

    return {
      status: "completed",
      text: result.text.trim(),
      mimeType: media.mimeType,
      modelName: result.modelName,
      finishReason: result.finishReason,
    };
  } catch (error: any) {
    logger.warn("meta.media_understanding.failed", {
      platform: params.platform,
      type,
      mediaId: params.mediaId,
      error: error?.message || String(error),
    });
    return {
      status: "failed",
      mimeType: declaredMimeType || undefined,
      errorCode: error?.message || "media_understanding_failed",
    };
  }
}
