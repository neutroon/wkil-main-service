import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { createBullMqJobId, metaExpressQueue } from "../core/meta.queue";
import { env } from "@config/env";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";

/**
 * T4 — Daily background cron that scans all active Facebook accounts and pages
 * for token health. Enqueues per-page validation jobs and flags accounts
 * whose user-level tokens are near expiry or already expired.
 */
export async function processTokenRefresh() {
  logger.info("facebook.token_refresh_cron.start");

  try {
    const now = new Date();
    const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    // 1. Find all active accounts
    const accounts = await prisma.facebookAccount.findMany({
      where: { isActive: true },
      select: { id: true, facebookUserId: true, expiresAt: true, isTokenValid: true },
    });

    let pageJobsQueued = 0;
    let accountsNearExpiry = 0;

    for (const account of accounts) {
      // --- T4: Account-level expiry check ---
      if (account.expiresAt) {
        const isExpired = account.expiresAt < now;
        const isNearExpiry = account.expiresAt < sevenDaysFromNow;

        if (isExpired || isNearExpiry) {
          // Mark account token as invalid so UI shows the warning banner
          await prisma.facebookAccount.update({
            where: { id: account.id },
            data: { isTokenValid: false },
          });

          // Also mark all pages of this account as invalid
          await prisma.facebookPage.updateMany({
            where: { facebookAccountId: account.id, isActive: true },
            data: { isTokenValid: false },
          });

          accountsNearExpiry++;
          logger.warn("facebook.token_refresh_cron.account_near_expiry", {
            accountId: account.id,
            facebookUserId: account.facebookUserId,
            expiresAt: account.expiresAt,
            isExpired,
          });

          // Skip per-page validation for this account — token is already dead
          continue;
        }
      }

      // --- T6: Enqueue per-page token validation jobs ---
      // Use findMany with select to avoid loading tokens into memory unnecessarily
      const pages = await prisma.facebookPage.findMany({
        where: { facebookAccountId: account.id, isActive: true },
        select: { pageId: true },
      });

      for (const page of pages) {
        await metaExpressQueue.add(
          "page_token_validation",
          {
            type: "page_token_validation",
            payload: { pageId: page.pageId },
          },
          {
            // Deduplication: prevent flooding queue with identical validation jobs
            jobId: createBullMqJobId("token-validate", page.pageId, now.toISOString().slice(0, 10)),
          }
        ).catch((err) => {
          // jobId collision (already queued today) = expected and safe to ignore
          if (!err.message?.includes("Job already exists")) {
            logger.error("facebook.token_refresh_cron.enqueue_failed", { pageId: page.pageId, error: err.message });
          }
        });
        pageJobsQueued++;
      }
    }

    logger.info("facebook.token_refresh_cron.completed", {
      accountsScanned: accounts.length,
      accountsNearExpiry,
      pageJobsQueued,
    });
  } catch (error: any) {
    logger.error("facebook.token_refresh_cron.failed", { error: error.message });
  }
}
