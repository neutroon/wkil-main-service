import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";

/**
 * Handles Facebook Page webhook subscription with exponential retry.
 * Ensures the 'messages', 'messaging_postbacks', and 'feed' fields are subscribed.
 */
export async function processWebhookSubscription(payload: { pageId: string; accessToken?: string }) {
  const { pageId, accessToken: providedToken } = payload;

  try {
    // 1. Get page details if token not provided
    let token = providedToken;
    if (!token) {
      const page = await prisma.facebookPage.findFirst({
        where: { pageId, isActive: true },
        select: { pageAccessToken: true },
      });
      if (!page) {
        logger.warn("facebook.webhook_sync.page_not_found", { pageId });
        return;
      }
      token = decryptFacebookSecret(page.pageAccessToken);
    }

    // 2. Call Meta API to subscribe
    const fbApiUrl = process.env.FB_API_URL || "https://graph.facebook.com/v22.0";
    const response = await fetch(
      `${fbApiUrl}/${pageId}/subscribed_apps?access_token=${token}&subscribed_fields=messages,messaging_postbacks,feed`,
      { method: "POST" }
    );

    const result = await response.json();

    if (result.success) {
      await prisma.facebookPage.updateMany({
        where: { pageId },
        data: {
          webhookStatus: "SUBSCRIBED",
          webhookCheckedAt: new Date(),
        },
      });
      logger.info("facebook.webhook_sync.success", { pageId });
    } else {
      throw new Error(result.error?.message || "Meta API returned success: false");
    }
  } catch (error: any) {
    logger.error("facebook.webhook_sync.failed", { pageId, error: error.message });

    await prisma.facebookPage.updateMany({
      where: { pageId },
      data: {
        webhookStatus: "FAILED",
        webhookCheckedAt: new Date(),
      },
    });

    // Throwing allows BullMQ to retry based on queue settings
    throw error;
  }
}
