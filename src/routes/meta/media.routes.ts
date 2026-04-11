import { Router, Request, Response } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import prisma from "../../config/prisma";
import { decryptFacebookSecret } from "../../utils/tokenCrypto";
import { getMetaMediaUrl, streamMetaMedia } from "../../services/meta/metaMedia.service";
import { logger } from "../../utils/logger";

const mediaRoutes = Router();

/**
 * GET /v1/meta/media/:conversationId/:mediaId
 * Securely fetches and streams media from Meta.
 * Ownership check: Ensure the requesting user owns the business profile associated with the conversation.
 */
mediaRoutes.get(
  "/:conversationId/:mediaId",
  authenticateToken,
  async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = (req as any).user.id as number;
      const conversationId = parseInt(req.params.conversationId, 10);
      const mediaId = req.params.mediaId;

      if (isNaN(conversationId) || !mediaId) {
        return res.status(400).json({ error: "Invalid parameters" });
      }

      // 1. Ownership & Channel Check
      const conversation = await prisma.conversation.findUnique({
        where: { id: conversationId },
        include: {
          businessProfile: {
            select: { userId: true },
          },
        },
      });

      if (!conversation || conversation.businessProfile.userId !== userId) {
        return res.status(403).json({ error: "Access denied or media not found" });
      }

      // 2. Fetch appropriate token based on channel
      let accessToken = "";
      if (conversation.channel === "whatsapp") {
        const account = await prisma.whatsAppAccount.findFirst({
           where: { phoneNumberId: conversation.pageId },
           select: { accessToken: true }
        });
        if (account) accessToken = decryptFacebookSecret(account.accessToken);
      } else if (conversation.channel === "messenger" || conversation.channel === "facebook_comment") {
        const page = await prisma.facebookPage.findFirst({
           where: { pageId: conversation.pageId },
           select: { pageAccessToken: true }
        });
        if (page) accessToken = decryptFacebookSecret(page.pageAccessToken);
      }

      if (!accessToken) {
        return res.status(404).json({ error: "Linked account token not found" });
      }

      // 3. Resolve and Stream
      const metaUrl = await getMetaMediaUrl(mediaId, accessToken);
      await streamMetaMedia(metaUrl, res);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("media_proxy.failed", { error: msg });
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal media proxy error" });
      }
    }
  }
);

export default mediaRoutes;
