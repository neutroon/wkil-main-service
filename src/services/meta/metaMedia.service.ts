import { Readable } from "stream";
import { logger } from "../../utils/logger";

const MEDIA_URL_CACHE = new Map<string, { url: string; expiresAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // Cache for 1 hour (Meta URLs usually last 5 mins to 24 hours)

/**
 * Unified "Smart Resolver" for Meta Media.
 * Automatically handles platform differences (WhatsApp IDs vs Messenger MIDs).
 */
export async function getMetaMediaUrl(
  id: string,
  accessToken: string,
  platform: "messenger" | "whatsapp" = "whatsapp",
  fallbackUrl?: string
): Promise<string> {
  const cacheKey = `${platform}:${id}`;
  const now = Date.now();
  const cached = MEDIA_URL_CACHE.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return cached.url;
  }

  try {
    let url = "";

    if (platform === "messenger") {
      // Messenger-Specific: Refresh via Message Attachments API
      const response = await fetch(
        `https://graph.facebook.com/v25.0/${id}?fields=attachments&access_token=${accessToken}`
      );
      
      if (response.ok) {
        const data = await response.json() as any;
        url = data.attachments?.data?.[0]?.payload?.url;
      } else {
        const errorData = await response.json() as any;
        logger.warn("meta.media.messenger_refresh_failed", { id, error: errorData });
      }
      
      // Fallback for specific Messenger IDs or if refresh failed
      if (!url) {
        const fallbackRes = await fetch(`https://graph.facebook.com/v25.0/${id}?access_token=${accessToken}`);
        if (fallbackRes.ok) {
          const fbData = await fallbackRes.json() as any;
          url = fbData.url;
        }
      }
    } else {
      // WhatsApp-Specific: Resolve Media Object ID
      const response = await fetch(`https://graph.facebook.com/v25.0/${id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (response.ok) {
        const data = await response.json() as { url: string };
        url = data.url;
      }
    }

    // FINAL PRODUCTION FALLBACK:
    // If we have a fallbackUrl from DB metadata, use it if Meta refresh failed.
    if (!url && fallbackUrl) {
       logger.info("meta.media.using_metadata_fallback", { platform, id });
       url = fallbackUrl;
    }

    if (!url) {
      throw new Error(`Failed to resolve ${platform} media URL for ID: ${id}`);
    }

    // Cache the resolved URL (Production standard: 1 hour)
    MEDIA_URL_CACHE.set(cacheKey, {
      url,
      expiresAt: now + CACHE_TTL_MS,
    });

    return url;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("meta.media.resolve_failed", { platform, id, error: msg });
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

    // Pipe the response body (Web ReadableStream) to the client (Node WritableStream)
    if (response.body) {
      Readable.fromWeb(response.body as any).pipe(res);
    } else {
      throw new Error("Empty response body from Meta");
    }
  } catch (err: unknown) {
    logger.error("meta.media.stream_failed", { url: metaUrl, error: String(err) });
    res.status(500).send("Failed to stream media");
  }
}
