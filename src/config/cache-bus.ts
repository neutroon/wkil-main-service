import { logger } from "@utils/logger";

/**
 * Cross-instance cache invalidation bus.
 *
 * The AI/pipeline/settings caches are per-process (in-memory). When an admin
 * edits config on instance A, instances B/C would otherwise keep stale values
 * for up to the 5-minute TTL. This module broadcasts a best-effort invalidation
 * over Redis pub/sub so every instance clears its local cache promptly.
 *
 * Design:
 *  - The publisher reuses the shared `redisClient` (`PUBLISH` is fine on a
 *    command connection).
 *  - The subscriber uses a DEDICATED connection (`redisClient.duplicate()`) —
 *    ioredis cannot mix subscribe-mode with normal commands. This mirrors the
 *    Socket.IO adapter setup in realtime/socket.ts.
 *  - Best-effort: if Redis is down, publish/subscribe silently no-op; the TTL
 *    is the correctness floor (invalidation is an optimization, never worse
 *    than today's behavior).
 */

export type CacheInvalidationKey =
  | "ai_models"
  | "ai_pipelines"
  | "settings"
  | "model_prices";

const CHANNEL = "cache:invalidate";

// Module-level references so graceful shutdown can close the subscriber
// connection and so callers don't pay the cost of `await import()` on every
// publish (it's the hot path of every admin write).
let redisClientRef: any = null;
let subscriberClient: any = null;
let subscriberStarted = false;

async function getRedisClient(): Promise<any> {
  if (redisClientRef) return redisClientRef;
  const mod = await import("@config/redis");
  redisClientRef = mod.redisClient;
  return redisClientRef;
}

/**
 * Publishes a cache-invalidation event to all backend instances. Fire-and-forget
 * and never throws — losing a message just means other instances wait for the
 * TTL (current behavior).
 */
export async function publishCacheInvalidation(
  key: CacheInvalidationKey,
): Promise<void> {
  try {
    const client = await getRedisClient();
    await client.publish(CHANNEL, key);
  } catch (error: any) {
    logger.warn("cache_bus.publish_failed", { key, error: error?.message });
  }
}

/**
 * Starts the pub/sub subscriber (once per process). On each message it clears
 * the matching local cache. Safe to call multiple times — only the first wires
 * the subscriber. No-op if it can't obtain Redis (the process still runs, just
 * without cross-instance invalidation).
 */
export async function startCacheBusSubscriber(): Promise<void> {
  if (subscriberStarted) return;
  try {
    const client = await getRedisClient();
    // Dedicated subscriber connection — cannot share with command usage.
    subscriberClient = client.duplicate();
    subscriberClient.on("error", (err: Error) =>
      logger.warn("cache_bus.subscriber_error", { error: err.message }),
    );
    await subscriberClient.subscribe(CHANNEL);
    subscriberClient.on("message", async (_channel: string, message: string) => {
      try {
        await handleInvalidation(message as CacheInvalidationKey);
      } catch (error: any) {
        logger.warn("cache_bus.handle_failed", {
          key: message,
          error: error?.message,
        });
      }
    });
    // Mark started only after a successful SUBSCRIBE — if anything above
    // throws, a retry can take a fresh connection.
    subscriberStarted = true;
    logger.info("cache_bus.subscriber_started", { channel: CHANNEL });
  } catch (error: any) {
    logger.warn("cache_bus.subscriber_skip", {
      reason: "redis client unavailable",
      error: error?.message,
    });
    subscriberClient = null;
  }
}

/** Closes the dedicated subscriber connection. Idempotent / no-op when the
 *  subscriber never started. Called from graceful shutdown. */
export async function stopCacheBusSubscriber(): Promise<void> {
  if (!subscriberClient) return;
  try {
    await subscriberClient.quit();
  } catch (error: any) {
    logger.warn("cache_bus.subscriber_close_failed", { error: error?.message });
  } finally {
    subscriberClient = null;
    subscriberStarted = false;
  }
}

/** Clears the local cache matching the invalidation key. */
async function handleInvalidation(key: CacheInvalidationKey): Promise<void> {
  switch (key) {
    case "ai_models": {
      const { clearAiModelCacheLocal } = await import(
        "@modules/admin/ai-model/ai-model.service"
      );
      // Local-only: the bus is delivering this invalidation already.
      // clearAiModelCache() (the publishing variant) would re-broadcast and
      // create a feedback loop.
      clearAiModelCacheLocal();
      break;
    }
    case "ai_pipelines": {
      const { clearPipelineCacheLocal } = await import(
        "@modules/admin/ai-pipeline/ai-pipeline.service"
      );
      clearPipelineCacheLocal();
      break;
    }
    case "settings": {
      const { clearSettingsCacheLocal } = await import(
        "@modules/settings/settings.service"
      );
      clearSettingsCacheLocal();
      break;
    }
    case "model_prices": {
      const { clearModelPriceCacheLocal } = await import(
        "@modules/billing/billing.service"
      );
      clearModelPriceCacheLocal();
      break;
    }
    default:
      logger.warn("cache_bus.unknown_key", { key });
  }
}
