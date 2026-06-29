import type { DevicePlatform, Prisma } from "@prisma/client";
import prisma from "@config/prisma";
import { logger } from "@utils/logger";

/**
 * Upsert an FCM device token for a user.
 *
 * Semantics:
 *   - If a row with the same `token` already exists, refresh
 *     `userId` (token may have moved to a new login) and `lastSeenAt`.
 *   - If no row exists, create one.
 *   - If the same `userId` already has a row for a *different* token
 *     on the same platform, leave it alone (the user may have multiple
 *     devices — phone + tablet).
 *
 * The `token` column is `@unique` so this is one DB round-trip.
 */
export async function upsertDeviceToken(params: {
  userId: number;
  token: string;
  platform: DevicePlatform;
}): Promise<void> {
  const { userId, token, platform } = params;
  try {
    await prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform, lastSeenAt: new Date() },
    });
  } catch (err) {
    logger.error("device_token.upsert_failed", {
      userId,
      platform,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Delete a single device token. Idempotent — no error if the row is
 * already gone. Used by the mobile client on logout.
 */
export async function deleteDeviceToken(params: {
  userId: number;
  token: string;
}): Promise<void> {
  await prisma.deviceToken.deleteMany({
    where: { userId: params.userId, token: params.token },
  });
}

/**
 * Bulk-delete tokens (e.g. when FCM reports them as unregistered).
 * Returns the number of rows actually removed.
 */
export async function deleteDeviceTokens(tokens: string[]): Promise<number> {
  if (tokens.length === 0) return 0;
  const res = await prisma.deviceToken.deleteMany({
    where: { token: { in: tokens } },
  });
  if (res.count > 0) {
    logger.info("device_token.bulk_cleanup", { removed: res.count });
  }
  return res.count;
}

/**
 * Look up every active FCM token belonging to a user, optionally
 * filtered by platform. Used by the handoff push fan-out.
 *
 * "Active" here means the row exists and `lastSeenAt` is within
 * `staleAfterDays` (default 90). The 90-day window matches the FCM
 * docs' "the token might be invalid" rule of thumb; older rows are
 * almost certainly gone.
 */
export async function listActiveTokensForUser(params: {
  userId: number;
  platform?: DevicePlatform;
  staleAfterDays?: number;
}): Promise<string[]> {
  const { userId, platform, staleAfterDays = 90 } = params;
  const cutoff = new Date(Date.now() - staleAfterDays * 24 * 60 * 60 * 1000);
  const where: Prisma.DeviceTokenWhereInput = {
    userId,
    lastSeenAt: { gte: cutoff },
    ...(platform ? { platform } : {}),
  };
  const rows = await prisma.deviceToken.findMany({ where, select: { token: true } });
  return rows.map((r) => r.token);
}

/**
 * Resolve "all users owning business X" to a flat list of FCM tokens,
 * partitioned by platform. Used by the handoff push fan-out.
 *
 * We hit the DeviceToken table directly via a Prisma join rather than
 * User → businessProfiles → User → DeviceToken because DeviceToken
 * already carries `userId`, and a single `findMany` with a `userId: { in }`
 * is one round-trip and reads from the right index.
 */
export async function listActiveTokensForBusiness(params: {
  businessProfileId: number;
  staleAfterDays?: number;
}): Promise<string[]> {
  const { businessProfileId, staleAfterDays = 90 } = params;
  const cutoff = new Date(Date.now() - staleAfterDays * 24 * 60 * 60 * 1000);

  // Find every User whose businessProfiles include this id. The
  // BusinessProfile -> User relation is `businessProfile.userId` so we
  // look up from the business side.
  const profiles = await prisma.businessProfile.findMany({
    where: { id: businessProfileId },
    select: { userId: true },
  });
  const userIds = profiles.map((p) => p.userId);
  if (userIds.length === 0) return [];

  const rows = await prisma.deviceToken.findMany({
    where: {
      userId: { in: userIds },
      lastSeenAt: { gte: cutoff },
    },
    select: { token: true },
  });
  return rows.map((r) => r.token);
}

/**
 * Touch a token's `lastSeenAt` without changing anything else. Called
 * from the mobile client on every cold start as a keep-alive.
 */
export async function touchDeviceToken(token: string): Promise<void> {
  try {
    await prisma.deviceToken.updateMany({
      where: { token },
      data: { lastSeenAt: new Date() },
    });
  } catch (err) {
    // Keep-alive is best-effort. Log and move on.
    logger.warn("device_token.touch_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
