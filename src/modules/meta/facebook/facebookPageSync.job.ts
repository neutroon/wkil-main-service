import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { getUserPages, saveFacebookPages } from "./facebook.service";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { createBullMqJobId, metaExpressQueue } from "../core/meta.queue";
import crypto from "crypto";

const FB_AUTH_ERROR_CODES = [190, 102, 2500]; // OAuthException codes

/**
 * Background job to synchronize Facebook pages for a specific account.
 * 
 * Features:
 * - Decrypts AES-encrypted token before Meta API call
 * - Handles expired/revoked tokens gracefully (marks account invalid, doesn't throw)
 * - Uses BullMQ jobId deduplication to prevent redundant webhook/validation jobs
 * - Non-blocking: individual page health check failures don't fail the sync
 */
export async function processFacebookPageSync(payload: { facebookAccountId: number }) {
  const { facebookAccountId } = payload;

  try {
    const account = await prisma.facebookAccount.findUnique({
      where: { id: facebookAccountId },
      select: { accessToken: true, facebookUserId: true, isActive: true },
    });

    if (!account || !account.isActive) {
      logger.warn("facebook.page_sync.account_not_found_or_inactive", { facebookAccountId });
      return;
    }

    // CRITICAL: Tokens are AES-encrypted in DB — must decrypt before Meta API call
    const plainToken = decryptFacebookSecret(account.accessToken);

    logger.info("facebook.page_sync.fetching", { facebookAccountId });
    
    let pages: Awaited<ReturnType<typeof getUserPages>>;
    try {
      pages = await getUserPages(plainToken);
    } catch (apiError: any) {
      // Check if this is an auth error (expired/revoked token)
      const errorCode = apiError?.code || apiError?.response?.data?.error?.code;
      const isAuthFailure = FB_AUTH_ERROR_CODES.includes(Number(errorCode))
        || apiError?.message?.toLowerCase()?.includes("oauth")
        || apiError?.message?.toLowerCase()?.includes("token")
        || apiError?.status === 401;

      if (isAuthFailure) {
        // Graceful: mark account token invalid, don't rethrow (no BullMQ retry needed)
        await prisma.facebookAccount.update({
          where: { id: facebookAccountId },
          data: { isTokenValid: false },
        });
        // Also mark all associated pages as invalid
        await prisma.facebookPage.updateMany({
          where: { facebookAccountId, isActive: true },
          data: { isTokenValid: false },
        });
        logger.warn("facebook.page_sync.auth_failure_flagged", { facebookAccountId });
        return; // Stop gracefully — no retry
      }

      // For transient errors (network, 5xx) re-throw to let BullMQ retry
      throw apiError;
    }

    if (pages.length === 0) {
      logger.info("facebook.page_sync.no_pages_found", { facebookAccountId });
      return;
    }

    // Persist to database
    await saveFacebookPages(facebookAccountId, pages);

    // Enqueue health checks
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    for (const page of pages) {
      // Webhook subscription — Trace ID pattern ensures 1 job per sync request, 
      // avoiding stale BullMQ locks while API rate limiters prevent user spam.
      const traceId = crypto.randomUUID();
      metaExpressQueue.add(
        "webhook_subscription",
        { type: "webhook_subscription", payload: { pageId: page.id, accessToken: page.access_token } },
        { jobId: createBullMqJobId("webhook-sub", page.id, traceId) }
      ).catch(() => {});

      // Token validation — deduplicated per page per day
      metaExpressQueue.add(
        "page_token_validation",
        { type: "page_token_validation", payload: { pageId: page.id } },
        { jobId: createBullMqJobId("token-validate", page.id, today) }
      ).catch(() => {});
    }

    logger.info("facebook.page_sync.completed", {
      facebookAccountId,
      pagesFound: pages.length,
    });
  } catch (error: any) {
    logger.error("facebook.page_sync.failed", { facebookAccountId, error: error.message });
    throw error; // Let BullMQ retry for non-auth errors
  }
}
