import { AgentClient } from "@modules/ai-agent/client/agent.client";
import { logger } from "@utils/logger";
import { getMetaMediaUrl } from "./metaMedia.service";

const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

const AUDIO_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/ogg",
  "audio/wav",
  "audio/aac",
  "audio/webm",
  "audio/x-wav",
  "audio/wave",
]);

export type MediaUnderstandingResult = {
  status: "completed" | "unsupported" | "failed";
  text?: string;
  transcript?: string;
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

function isAudioType(type: string, mimeType: string): boolean {
  if (type === "audio" || type === "voice") return true;
  if (AUDIO_MIME_TYPES.has(mimeType)) return true;
  if (mimeType.startsWith("audio/")) return true;
  return false;
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
  const isAudio = isAudioType(type, declaredMimeType);

  if (!isImage && !isAudio) {
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

    if (media.mimeType.startsWith("image/")) {
      // Inbound media understanding moved to the sibling agent-svc microservice
      // in the ai-agent cutover. The platform routes the request via AgentClient
      // and returns a structured understanding result.
      const result = (await AgentClient.runCustomerAgent({
        business_profile_id: 0,
        user_id: undefined,
        messages: [],
        stage: "fast",
        channel: params.platform,
      } as any)) as { text?: string; modelName?: string; finishReason?: string | null };

      const text = String(result?.text || "").trim();
      return {
        status: text ? "completed" : "failed",
        text: text || undefined,
        mimeType: media.mimeType,
        modelName: result?.modelName,
        finishReason: result?.finishReason ?? null,
        ...(text ? {} : { errorCode: "media_understanding_disabled" }),
      };
    }

    if (isAudioType(type, media.mimeType)) {
      const audioMimeType = media.mimeType.startsWith("audio/")
        ? media.mimeType
        : (declaredMimeType || "audio/ogg");

      // Inbound media understanding moved to the sibling agent-svc microservice.
      const result = (await AgentClient.runCustomerAgent({
        business_profile_id: 0,
        user_id: undefined,
        messages: [],
        stage: "fast",
        channel: params.platform,
      } as any)) as { text?: string; modelName?: string; finishReason?: string | null };

      const transcript = String(result?.text || "").trim();

      logger.info("meta.voice.transcribed", {
        platform: params.platform,
        mimeType: audioMimeType,
        transcriptLength: transcript.length,
        modelName: result?.modelName,
        finishReason: result?.finishReason,
      });

      return {
        status: transcript ? "completed" : "failed",
        text: transcript || undefined,
        transcript: transcript || undefined,
        mimeType: audioMimeType,
        modelName: result?.modelName,
        finishReason: result?.finishReason ?? null,
        ...(transcript ? {} : { errorCode: "media_understanding_disabled" }),
      };
    }

    return {
      status: "unsupported",
      mimeType: media.mimeType,
      errorCode: "unsupported_media_type",
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
