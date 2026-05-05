import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { env } from "@config/env";

/**
 * T6 — Validates a Facebook Page access token using the /debug_token endpoint.
 * 
 * Strategy:
 * - Uses App Token (AppId|AppSecret) to call /debug_token — the authoritative Meta API
 *   for checking token validity, expiry, and granted scopes.
 * - Falls back to simple /me call if App credentials are unavailable.
 * - Updates isTokenValid and lastValidatedAt on every run.
 */
export async function processPageTokenValidation(payload: { pageId: string }) {
  const { pageId } = payload;

  try {
    const page = await prisma.facebookPage.findFirst({
      where: { pageId, isActive: true },
      select: { id: true, pageAccessToken: true },
    });

    if (!page) {
      logger.warn("facebook.token_validation.page_not_found", { pageId });
      return;
    }

    const token = decryptFacebookSecret(page.pageAccessToken);
    const fbApiUrl = env.FB_API_URL || "https://graph.facebook.com/v22.0";
    const appId = env.FB_APP_ID;
    const appSecret = env.FB_APP_SECRET;

    let isValid = false;

    if (appId && appSecret) {
      // Preferred: Use /debug_token with app token — checks expiry, revocation, scopes
      const appToken = `${appId}|${appSecret}`;
      const response = await fetch(
        `${fbApiUrl}/debug_token?input_token=${token}&access_token=${appToken}`,
        { method: "GET" }
      );
      const result = await response.json();
      const debugData = result?.data;

      if (!debugData) {
        throw new Error("Unexpected /debug_token response format");
      }

      isValid = debugData.is_valid === true;

      // Extra guard: if token expires soon (< 7 days), mark as invalid proactively
      if (isValid && debugData.expires_at) {
        const expiresAt = new Date(debugData.expires_at * 1000);
        const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        if (expiresAt < sevenDaysFromNow) {
          logger.warn("facebook.token_validation.expiring_soon", { pageId, expiresAt });
          isValid = false; // Treat near-expiry as invalid to force user to reconnect
        }
      }

      logger.info("facebook.token_validation.debug_token", {
        pageId,
        isValid,
        expiresAt: debugData.expires_at,
        scopes: debugData.scopes,
      });
    } else {
      // Fallback: simple /me call to check if token is functional
      const response = await fetch(
        `${fbApiUrl}/me?access_token=${token}&fields=id`,
        { method: "GET" }
      );
      const result = await response.json();
      // For page tokens, /me returns the page itself — id should match pageId
      isValid = result.id === pageId;
    }

    await prisma.facebookPage.update({
      where: { id: page.id },
      data: {
        isTokenValid: isValid,
        lastValidatedAt: new Date(),
      },
    });

    if (isValid) {
      logger.info("facebook.token_validation.success", { pageId });
    } else {
      logger.warn("facebook.token_validation.invalid_token", { pageId });
    }
  } catch (error: any) {
    logger.error("facebook.token_validation.error", { pageId, error: error.message });

    // On unexpected errors, mark as invalid to be safe (fail-closed)
    await prisma.facebookPage.updateMany({
      where: { pageId },
      data: {
        isTokenValid: false,
        lastValidatedAt: new Date(),
      },
    }).catch(() => {});
  }
}
