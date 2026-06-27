import { Readable } from "stream";
import { logger } from "@utils/logger";
import { AppError } from "@middlewares/errorHandler.middleware";
import { cache } from "@utils/cache";

import { metaClient } from "@utils/apiClient";

/**
 * Unified "Smart Resolver" for Meta Media.
 * Automatically handles platform differences (WhatsApp IDs vs Messenger MIDs).
 */
export async function getMetaMediaUrl(
  id: string,
  accessToken: string,
  platform: "messenger" | "whatsapp" = "whatsapp",
  fallbackUrl?: string,
): Promise<string> {
  const cacheKey = `meta:media:${platform}:${id}`;

  return cache.getOrSet(
    cacheKey,
    async () => {
      try {
        let url = "";

        if (platform === "messenger") {
          // Query the /attachments edge specifically.
          const { data } = await metaClient.get(`/${id}/attachments`, {
            params: { access_token: accessToken },
          });

          const result = data as { data: any[] };
          const att = result.data?.[0];

          // Primary resolution path
          let pathUsed = "";
          if (att?.file_url) {
            url = att.file_url;
            pathUsed = "file_url";
          } else if (att?.image_data?.url) {
            url = att.image_data.url;
            pathUsed = "image_data";
          } else if (att?.video_data?.url) {
            url = att.video_data.url;
            pathUsed = "video_data";
          } else if (att?.audio_data?.url) {
            url = att.audio_data.url;
            pathUsed = "audio_data";
          } else if (att?.payload?.url) {
            url = att.payload.url;
            pathUsed = "payload";
          }

          if (url) {
            logger.info("meta.media.messenger_refresh_success", { id, pathUsed });
          }

          // Final API fallback if the specialized /attachments edge failed
          if (!url) {
            const fallbackRes = await metaClient.get(`/${id}`, {
              params: { access_token: accessToken },
            });
            url = (fallbackRes.data as any).url;
          }
        } else {
          // WhatsApp-Specific: Resolve Media Object ID
          const { data } = await metaClient.get(`/${id}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          url = (data as { url: string }).url;
        }

        // FINAL PRODUCTION FALLBACK:
        if (!url && fallbackUrl) {
          logger.info("meta.media.using_metadata_fallback", { platform, id });
          url = fallbackUrl;
        }

        if (!url) {
          throw new AppError(`Failed to resolve ${platform} media URL for ID: ${id}`, 404);
        }

        return url;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("meta.media.resolve_failed", { platform, id, error: msg });
        throw err;
      }
    },
    3600 // 1 hour TTL
  );
}

/**
 * Streams the media from Meta to the client.
 * This is the MOST professional way to handle it because:
 * 1. It keeps Meta's temporary URLs private from the frontend.
 * 2. It bypasses potential CORS issues on the client side.
 * 3. It allows us to handle authentication and logging in one place.
 */
export async function streamMetaMedia(
  metaUrl: string,
  res: any, // Express Response
) {
  try {
    const response = await fetch(metaUrl);
    if (!response.ok) throw new AppError("Could not stream from Meta", 502);

    const contentType = response.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);

    // Pipe the response body (Web ReadableStream) to the client (Node WritableStream)
    if (response.body) {
      Readable.fromWeb(response.body as any).pipe(res);
    } else {
      throw new AppError("Empty response body from Meta", 502);
    }
  } catch (err: unknown) {
    logger.error("meta.media.stream_failed", {
      url: metaUrl,
      error: String(err),
    });
    res.status(500).send("Failed to stream media");
  }
}




