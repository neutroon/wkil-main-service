import fetch from "node-fetch";
import { logger } from "../../utils/logger";

const MEDIA_URL_CACHE = new Map<string, { url: string; expiresAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // Cache for 1 hour (Meta URLs usually last 5 mins to 24 hours)

/**
 * Fetches a fresh binary download URL from Meta using a mediaId.
 */
export async function getMetaMediaUrl(
  mediaId: string,
  accessToken: string,
): Promise<string> {
  const cacheKey = `${mediaId}`;
  const now = Date.now();
  const cached = MEDIA_URL_CACHE.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return cached.url;
  }

  try {
    const response = await fetch(`https://graph.facebook.com/v25.0/${mediaId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const err = await response.json();
      logger.error("meta.media.fetch_url_failed", { mediaId, error: err });
      throw new Error("Failed to fetch media URL from Meta");
    }

    const data = (await response.json()) as { url: string };
    if (!data.url) {
      throw new Error("Meta response did not contain a media URL");
    }

    // Cache the resolved URL
    MEDIA_URL_CACHE.set(cacheKey, {
      url: data.url,
      expiresAt: now + CACHE_TTL_MS,
    });

    return data.url;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("meta.media.resolve_failed", { mediaId, error: msg });
    throw err;
  }
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
    if (!response.ok) throw new Error("Could not stream from Meta");

    const contentType = response.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);

    // Pipe the response body to the client
    response.body.pipe(res);
  } catch (err: unknown) {
    logger.error("meta.media.stream_failed", { url: metaUrl, error: String(err) });
    res.status(500).send("Failed to stream media");
  }
}
