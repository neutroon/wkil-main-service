import prisma from "@config/prisma";
import { cache } from "@utils/cache";
import { logger } from "@utils/logger";

const CACHE_TTL_SECONDS = 86400; // 24 hours (safe because of active invalidation)

/**
 * Checks if a Facebook Page can be routed to a business profile.
 * Webhooks can arrive for pages that are connected to the user's Facebook
 * account but not linked to any business yet. Those events must be discarded
 * before they hit BullMQ, because the worker cannot know which AI/profile owns
 * the message.
 */
export async function isRoutableFacebookPage(pageId: string): Promise<boolean> {
  const cacheKey = `cache:routable_page:${pageId}`;
  
  const cached = await cache.get<string>(cacheKey);
  if (cached !== null) {
    return cached === "1";
  }

  // Cache miss, check DB
  const routablePage = await prisma.facebookPage.findFirst({
    where: { pageId, isActive: true, businessProfileId: { not: null } },
    select: { id: true },
  });

  const isRoutable = !!routablePage;
  await cache.set(cacheKey, isRoutable ? "1" : "0", CACHE_TTL_SECONDS);

  return isRoutable;
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
  await Promise.all([
    cache.delete(`cache:known_page:${pageId}`),
    cache.delete(`cache:routable_page:${pageId}`),
  ]);
  logger.info("webhook_cache.invalidated_page", { pageId });
}

/**
 * Invalidate the resolved identity cache for a Messenger page or WhatsApp number.
 * MUST be called on every connect, disconnect, link, unlink, and settings change
 * to ensure the processor always gets fresh identity data.
 */
export async function invalidateIdentityCache(
  platform: "messenger" | "whatsapp",
  identifier: string
): Promise<void> {
  const cacheKey = `identity:${platform}:${identifier}`;
  await cache.delete(cacheKey);
  logger.info("webhook_cache.identity_invalidated", { platform, identifier });
}

/**
 * Invalidate WhatsApp Account cache (e.g., when unlinked or deactivated)
 */
export async function invalidateWhatsAppAccountCache(phoneNumberId: string): Promise<void> {
  const cacheKey = `cache:known_wa:${phoneNumberId}`;
  await cache.delete(cacheKey);
  logger.info("webhook_cache.invalidated_wa", { phoneNumberId });
}
