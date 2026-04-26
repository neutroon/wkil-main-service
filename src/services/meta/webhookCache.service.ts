import prisma from "../../config/prisma";
import { cache } from "../../utils/cache";
import { logger } from "../../utils/logger";

const CACHE_TTL_SECONDS = 86400; // 24 hours (safe because of active invalidation)

/**
 * Checks if a Facebook Page ID is known and active.
 * Uses a 5-minute Redis cache to prevent DB overload during webhook spikes.
 */
export async function isKnownFacebookPage(pageId: string): Promise<boolean> {
  const cacheKey = `cache:known_page:${pageId}`;
  
  const cached = await cache.get<string>(cacheKey);
  if (cached !== null) {
    return cached === "1";
  }

  // Cache miss, check DB
  const knownPage = await prisma.facebookPage.findFirst({
    where: { pageId, isActive: true },
    select: { id: true },
  });

  const isKnown = !!knownPage;
  await cache.set(cacheKey, isKnown ? "1" : "0", CACHE_TTL_SECONDS);

  return isKnown;
}

/**
 * Checks if a WhatsApp Phone Number ID is known and active.
 * Uses a 5-minute Redis cache to prevent DB overload during webhook spikes.
 */
export async function isKnownWhatsAppAccount(phoneNumberId: string): Promise<boolean> {
  const cacheKey = `cache:known_wa:${phoneNumberId}`;
  
  const cached = await cache.get<string>(cacheKey);
  if (cached !== null) {
    return cached === "1";
  }

  // Cache miss, check DB
  const knownAccount = await prisma.whatsAppAccount.findFirst({
    where: { phoneNumberId, isActive: true },
    select: { id: true },
  });

  const isKnown = !!knownAccount;
  await cache.set(cacheKey, isKnown ? "1" : "0", CACHE_TTL_SECONDS);

  return isKnown;
}

/**
 * Invalidate Facebook Page cache (e.g., when unlinked or deactivated)
 */
export async function invalidateFacebookPageCache(pageId: string): Promise<void> {
  const cacheKey = `cache:known_page:${pageId}`;
  await cache.delete(cacheKey);
  logger.info("webhook_cache.invalidated_page", { pageId });
}

/**
 * Invalidate WhatsApp Account cache (e.g., when unlinked or deactivated)
 */
export async function invalidateWhatsAppAccountCache(phoneNumberId: string): Promise<void> {
  const cacheKey = `cache:known_wa:${phoneNumberId}`;
  await cache.delete(cacheKey);
  logger.info("webhook_cache.invalidated_wa", { phoneNumberId });
}

/**
 * ELITE TIER: Atomic deduplication to prevent double AI replies.
 * Returns true if the webhook is currently being processed (idempotency lock).
 * TTL of 90s is enough to cover the AI thinking time.
 * Reasoning tag [v4.3]
 */
export async function isDuplicateWebhook(externalId: string): Promise<boolean> {
  if (!externalId) return false;
  const cacheKey = `lock:webhook:${externalId}`;
  
  // We use redisClient directly for atomic SET NX since the cache utility
  // currently doesn't expose the raw SET response for NX.
  // This is acceptable as it's a specific atomic operation.
  const { redisClient } = await import("../../config/redis");
  const result = await redisClient.set(cacheKey, "1", "EX", 90, "NX");
  return result === null; 
}
