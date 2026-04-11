import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import prisma from "../../config/prisma";
import { decryptFacebookSecret } from "../../utils/tokenCrypto";
import { getMetaMediaUrl } from "../../services/meta/metaMedia.service";
import { logger } from "../../utils/logger";

const mediaRoutes = Router();

/**
 * GET /v1/meta/media/:conversationId/:mediaId
 * Securely fetches and streams media from Meta.
 * Supports token-based query authentication for browser tags.
 */
mediaRoutes.get(
  "/:conversationId/:mediaId",
  async (req: Request, res: Response) => {
    try {
      const conversationId = parseInt(req.params.conversationId, 10);
      const mediaId = req.params.mediaId;

      if (isNaN(conversationId) || !mediaId) {
        return res.status(400).json({ error: "Invalid parameters" });
      }

      // 1. Unified Authentication (Header, Cookie, or Query)
      let token = req.headers.authorization?.startsWith("Bearer ") 
        ? req.headers.authorization.split(" ")[1] 
        : (req.cookies?.accessToken || (req.query.token as string));

      if (!token) return res.status(401).json({ error: "Access token required" });

      const decoded = jwt.verify(token, process.env.JWT_SECRET || "supersecret") as any;
      const userId = decoded.id;

      // 2. Ownership Verification
      const phoneNumberIds = await getUserPhoneNumberIds(userId);
      const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, pageId: { in: phoneNumberIds } }
      });

      if (!conversation) {
        return res.status(404).json({ error: "Access denied or media not found" });
      }

      // 3. Platform Credential Discovery
      let accessToken = "";
      if (conversation.channel === "whatsapp") {
        const account = await prisma.whatsAppAccount.findFirst({
          where: { phoneNumberId: conversation.pageId, isActive: true },
          select: { accessToken: true }
        });
        if (account) accessToken = decryptFacebookSecret(account.accessToken);
      } else {
        const page = await prisma.facebookPage.findFirst({
          where: { pageId: conversation.pageId, isActive: true },
          select: { pageAccessToken: true }
        });
        if (page) accessToken = decryptFacebookSecret(page.pageAccessToken);
      }

      if (!accessToken) return res.status(401).json({ error: "Meta credentials missing" });

      // 4. Resolve & Stream
      const url = await getMetaMediaUrl(mediaId, accessToken);
      const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) throw new Error(`Meta binary fetch failed: ${response.status}`);

      const contentType = response.headers.get("content-type");
      if (contentType) res.setHeader("Content-Type", contentType);
      
      // Cache for performance
      res.setHeader("Cache-Control", "public, max-age=3600");

      const arrayBuffer = await response.arrayBuffer();
      res.send(Buffer.from(arrayBuffer));

    } catch (e: any) {
      logger.error("meta.media_proxy_failed", { error: e.message });
      res.status(500).json({ error: "Internal media proxy error" });
    }
  }
);

// Helper function to get phone number IDs the user identifies with
async function getUserPhoneNumberIds(userId: number): Promise<string[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      businessProfiles: {
        include: {
          whatsAppAccounts: true,
          facebookPages: true,
        },
      },
      managedUsers: {
        include: {
          user: {
            include: {
              businessProfiles: {
                include: {
                  whatsAppAccounts: true,
                  facebookPages: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!user) return [];

  const ids = new Set<string>();

  // From own profiles
  user.businessProfiles.forEach((bp: any) => {
    bp.whatsAppAccounts.forEach((wa: any) => ids.add(wa.phoneNumberId));
    bp.facebookPages.forEach((fp: any) => ids.add(fp.pageId));
  });

  // From managed users' profiles
  user.managedUsers.forEach((mgmt: any) => {
    mgmt.user.businessProfiles.forEach((bp: any) => {
      bp.whatsAppAccounts.forEach((wa: any) => ids.add(wa.phoneNumberId));
      bp.facebookPages.forEach((fp: any) => ids.add(fp.pageId));
    });
  });

  return Array.from(ids);
}

export default mediaRoutes;
