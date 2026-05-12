import prisma from "@config/prisma";
import { cache } from "@utils/cache";
import { logger } from "@utils/logger";

const ROUTABLE_CACHE_TTL_SECONDS = 300;
const NEGATIVE_ROUTABLE_CACHE_TTL_SECONDS = 30;

export type FacebookPageRoute = {
  businessProfileId: number;
};

/**
 * Checks if a Facebook Page can be routed to a business profile.
 * Webhooks can arrive for pages that are connected to the user's Facebook
 * account but not linked to any business yet. Those events must be discarded
 * before they hit BullMQ, because the worker cannot know which AI/profile owns
 * the message.
 */
export async function getRoutableFacebookPageRoute(
  pageId: string,
): Promise<FacebookPageRoute | null> {
  const cacheKey = `cache:routable_page:${pageId}`;
  
  const cached = await cache.get<string>(cacheKey);
  if (cached !== null) {
    if (cached === "0") return null;
    try {
      const parsed = JSON.parse(cached) as FacebookPageRoute;
      if (parsed?.businessProfileId) return parsed;
    } catch {
      // Legacy cache entries used "1" for true. Delete and re-check the DB so
      // the worker receives the exact business profile route.
    }
    await cache.delete(cacheKey);
  }

  // Cache miss, check DB
  const routablePage = await prisma.facebookPage.findFirst({
    where: { pageId, isActive: true, businessProfileId: { not: null } },
    orderBy: { updatedAt: "desc" },
    select: { businessProfileId: true },
  });

  const route = routablePage?.businessProfileId
    ? { businessProfileId: routablePage.businessProfileId }
    : null;
  await cache.set(
    cacheKey,
    route ? JSON.stringify(route) : "0",
    route ? ROUTABLE_CACHE_TTL_SECONDS : NEGATIVE_ROUTABLE_CACHE_TTL_SECONDS,
  );

  return route;
}

export async function isRoutableFacebookPage(pageId: string): Promise<boolean> {
  return (await getRoutableFacebookPageRoute(pageId)) !== null;
}

/**
 * Checks if a WhatsApp Phone Number ID can be routed to a business profile.
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
    where: { phoneNumberId, isActive: true, businessProfileId: { not: null } },
    select: { id: true },
  });

  const isKnown = !!knownAccount;
  await cache.set(
    cacheKey,
    isKnown ? "1" : "0",
    isKnown ? ROUTABLE_CACHE_TTL_SECONDS : NEGATIVE_ROUTABLE_CACHE_TTL_SECONDS,
  );

  return isKnown;
}

/**
 * Invalidate Facebook Page cache (e.g., when unlinked or deactivated)
 */
export async function invalidateFacebookPageCache(pageId: string): Promise<void> {
  await Promise.all([
    cache.delete(`cache:known_page:${pageId}`),
    cache.delete(`cache:routable_page:${pageId}`),
    cache.delete(`identity:messenger:${pageId}`),
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
  await Promise.all([
    cache.delete(`cache:known_wa:${phoneNumberId}`),
    cache.delete(`identity:whatsapp:${phoneNumberId}`),
  ]);
  logger.info("webhook_cache.invalidated_wa", { phoneNumberId });
}
