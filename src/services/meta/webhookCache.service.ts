import prisma from "../../config/prisma";
import { redisClient } from "../../config/redis";
import { logger } from "../../utils/logger";

const CACHE_TTL_SECONDS = 86400; // 24 hours (safe because of active invalidation)

/**
 * Checks if a Facebook Page ID is known and active.
 * Uses a 5-minute Redis cache to prevent DB overload during webhook spikes.
 */
export async function isKnownFacebookPage(pageId: string): Promise<boolean> {
  const cacheKey = `cache:known_page:${pageId}`;
  
  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      return cached === "1";
    }
  } catch (error) {
    logger.warn("webhook_cache.redis_get_error", { error: String(error) });
  }

  // Cache miss, check DB
  const knownPage = await prisma.facebookPage.findFirst({
    where: { pageId, isActive: true },
    select: { id: true },
  });

  const isKnown = !!knownPage;

  try {
    await redisClient.set(cacheKey, isKnown ? "1" : "0", "EX", CACHE_TTL_SECONDS);
  } catch (error) {
    logger.warn("webhook_cache.redis_set_error", { error: String(error) });
  }

  return isKnown;
}

/**
 * Checks if a WhatsApp Phone Number ID is known and active.
 * Uses a 5-minute Redis cache to prevent DB overload during webhook spikes.
 */
export async function isKnownWhatsAppAccount(phoneNumberId: string): Promise<boolean> {
  const cacheKey = `cache:known_wa:${phoneNumberId}`;
  
  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      return cached === "1";
    }
  } catch (error) {
    logger.warn("webhook_cache.redis_get_error", { error: String(error) });
  }

  // Cache miss, check DB
  const knownAccount = await prisma.whatsAppAccount.findFirst({
    where: { phoneNumberId, isActive: true },
    select: { id: true },
  });

  const isKnown = !!knownAccount;

  try {
    await redisClient.set(cacheKey, isKnown ? "1" : "0", "EX", CACHE_TTL_SECONDS);
  } catch (error) {
    logger.warn("webhook_cache.redis_set_error", { error: String(error) });
  }

  return isKnown;
}

/**
 * Invalidate Facebook Page cache (e.g., when unlinked or deactivated)
 */
export async function invalidateFacebookPageCache(pageId: string): Promise<void> {
  const cacheKey = `cache:known_page:${pageId}`;
  try {
    await redisClient.del(cacheKey);
    logger.info("webhook_cache.invalidated_page", { pageId });
  } catch (error) {
    logger.warn("webhook_cache.redis_del_error", { error: String(error) });
  }
}

/**
 * Invalidate WhatsApp Account cache (e.g., when unlinked or deactivated)
 */
export async function invalidateWhatsAppAccountCache(phoneNumberId: string): Promise<void> {
  const cacheKey = `cache:known_wa:${phoneNumberId}`;
  try {
    await redisClient.del(cacheKey);
    logger.info("webhook_cache.invalidated_wa", { phoneNumberId });
  } catch (error) {
    logger.warn("webhook_cache.redis_del_error", { error: String(error) });
  }
}

/**
 * ELITE TIER: Atomic deduplication to prevent double AI replies.
 * Returns true if the webhook is currently being processed (idempotency lock).
 * TTL of 30s is enough to cover the AI thinking time.
 */
export async function isDuplicateWebhook(externalId: string): Promise<boolean> {
  if (!externalId) return false;
  const cacheKey = `lock:webhook:${externalId}`;
  
  try {
    // SET with NX (Only if not exists) and EX (Expiration)
    const result = await redisClient.set(cacheKey, "1", "EX", 30, "NX");
    return result === null; 
  } catch (error) {
    logger.warn("webhook_cache.lock_error", { error: String(error) });
    return false; // Fail open (allow processing) if Redis is unstable
  }
}
