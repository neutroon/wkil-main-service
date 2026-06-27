import { Router, Request, Response } from "express";
import prisma from "@config/prisma";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { getMetaMediaUrl } from "@modules/meta/core/metaMedia.service";

import { authenticateToken } from "@modules/auth/core/auth.middleware";
import { validate } from "@middlewares/validate.middleware";
import { metaMediaSchema } from "@modules/meta/core/metaMedia.validation";
import { AppError } from "@middlewares/errorHandler.middleware";

const mediaRoutes = Router();

/**
 * GET /v1/meta/media/:conversationId/:mediaId
 * Securely fetches and streams media from Meta.
 */
mediaRoutes.get(
  "/:conversationId/:mediaId",
  authenticateToken,
  validate(metaMediaSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id;
    const conversationId = parseInt(req.params.conversationId, 10);
    const mediaId = req.params.mediaId;

    // 1. Ownership Verification
    const phoneNumberIds = await getUserPhoneNumberIds(userId);
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, pageId: { in: phoneNumberIds } },
    });

    if (!conversation) {
      throw new AppError("Access denied or media not found", 404);
    }

    // 2. Platform Credential Discovery
    let accessToken = "";
    if (conversation.channel === "whatsapp") {
      const account = await prisma.whatsAppAccount.findFirst({
        where: { phoneNumberId: conversation.pageId, isActive: true },
        select: { accessToken: true },
      });
      if (account) accessToken = decryptFacebookSecret(account.accessToken);
    } else {
      const page = await prisma.facebookPage.findFirst({
        where: { pageId: conversation.pageId, isActive: true },
        select: { pageAccessToken: true },
      });
      if (page) accessToken = decryptFacebookSecret(page.pageAccessToken);
    }

    if (!accessToken) throw new AppError("Meta credentials missing", 401);

    // 3. Resolve & Stream
    let resolveId = mediaId;

    const msg = await prisma.conversationMessage.findFirst({
      where: { conversationId, mediaId },
    });

    if (conversation.channel === "messenger" && msg?.externalId) {
      resolveId = msg.externalId;
    }

    let url: string;
    try {
      url = await getMetaMediaUrl(
        resolveId,
        accessToken,
        conversation.channel as any,
        (msg?.mediaMetadata as any)?.url,
      );
    } catch (err: any) {
      throw new AppError(
        `Failed to resolve media URL: ${err?.message || "unknown"}`,
        502,
      );
    }

    // Guard against malformed/empty URLs from the resolver (e.g.
    // expired pre-signed Meta CDN URLs, or a missing attachment).
    // Without this, `fetch("")` / `fetch(relative-path)` throws
    // `TypeError: Invalid URL` and surfaces to the client as a
    // confusing 502 instead of a clear 404.
    if (!url || !/^https?:\/\//i.test(url)) {
      throw new AppError("Media URL is missing or invalid", 404);
    }

    let metaResponse: globalThis.Response;
    try {
      metaResponse = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (err: any) {
      // Network/DNS/parse errors land here (e.g. "Invalid URL",
      // getaddrinfo ENOTFOUND, TLS handshake failures).
      throw new AppError(
        `Media fetch failed: ${err?.message || "network error"}`,
        502,
      );
    }
    if (!metaResponse.ok)
      throw new AppError(`Meta binary fetch failed: ${metaResponse.status}`, 502);

    const contentType = metaResponse.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Vary", "Origin");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "public, max-age=3600");

    if (metaResponse.body) {
      const readableStream = metaResponse.body as any;
      if (typeof readableStream.pipe === "function") {
        readableStream.pipe(res);
      } else {
        const reader = metaResponse.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      }
    } else {
      throw new AppError("Empty response from Meta", 502);
    }
  },
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
          widgetInstalls: true,
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
                  widgetInstalls: true,
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

  user.businessProfiles.forEach((bp: any) => {
    bp.whatsAppAccounts.forEach((wa: any) => ids.add(wa.phoneNumberId));
    bp.facebookPages.forEach((fp: any) => ids.add(fp.pageId));
    bp.widgetInstalls.forEach((wi: any) => ids.add(`widget:${wi.id}`));
  });

  user.managedUsers.forEach((mgmt: any) => {
    mgmt.user.businessProfiles.forEach((bp: any) => {
      bp.whatsAppAccounts.forEach((wa: any) => ids.add(wa.phoneNumberId));
      bp.facebookPages.forEach((fp: any) => ids.add(fp.pageId));
      bp.widgetInstalls.forEach((wi: any) => ids.add(`widget:${wi.id}`));
    });
  });

  return Array.from(ids);
}

export default mediaRoutes;
