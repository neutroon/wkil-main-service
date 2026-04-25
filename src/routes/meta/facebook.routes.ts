import { Router, Request, Response } from "express";
import {
  generateAuthUrl,
  exchangeCodeForToken,
  getUserPages,
  createPost,
  schedulePost,
  getPostComments,
  replyToComment,
  saveFacebookToken,
  saveFacebookPages,
  getUserFacebookAccounts,
  getUserAnalytics,
  getAdminAnalytics,
  deactivateFacebookAccount,
  logFacebookActivity,
  getPagePosts,
  getPageDetails,
  deleteFacebookPost,
  validateAccessToken,
  deactivateFacebookPage,
  switchDevice,
  sendPrivateReply,
} from "../../services/meta/facebook.service";
import { 
  getOrCreateConversation, 
  saveMessage,
} from "../../services/meta/conversation.service";
import { decryptFacebookSecret } from "../../utils/tokenCrypto";
import { emitToBusiness, emitToConversation } from "../../utils/socket";
import { logger } from "../../utils/logger";
import { authenticateToken } from "../../middlewares/auth.middleware";
import {
  validateFacebookPost,
  validateFacebookSchedule,
} from "../../middlewares/validation.middleware";
import { facebookLimiter } from "../../middlewares/rateLimit.middleware";
import prisma from "../../config/prisma";

interface AuthRequest extends Request {
  user: {
    id: number;
    email: string;
    role: string;
  };
}

const facebookRoutes = Router();

// Step 0: Initiate Facebook OAuth flow
facebookRoutes.get("/login", (req: Request, res: Response) => {
  try {
    const { redirect_uri } = req.query;

    if (!redirect_uri) {
      return res.status(400).json({ error: "redirect_uri is required" });
    }

    const authUrl = generateAuthUrl({ redirect_uri: redirect_uri as string });
    res.json({ authUrl });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Step 1: Exchange code for user access token and save to database
facebookRoutes.get(
  "/login/callback",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { code, redirect_uri } = req.query;
      const userId = (req as AuthRequest).user.id;

      if (!code || !redirect_uri) {
        return res
          .status(400)
          .json({ error: "code and redirect_uri are required" });
      }

      const tokenData = await exchangeCodeForToken({
        code: code as string,
        redirect_uri: redirect_uri as string,
      });

      // Get user info from Facebook
      const userInfoResponse = await fetch(
        `https://graph.facebook.com/me?access_token=${tokenData.access_token}&fields=id,name,email,picture`,
      );
      const userInfo = await userInfoResponse.json();
      console.log("User info:", userInfo);

      // Extract device info from request
      const deviceInfo = {
        userAgent: req.get("User-Agent") || "",
        platform: req.get("sec-ch-ua-platform") || "Unknown",
        browser: req.get("sec-ch-ua") || "Unknown",
        device: req.get("sec-ch-ua-mobile") === "?1" ? "Mobile" : "Desktop",
      };

      // Save token to database
      const facebookAccount = await saveFacebookToken(
        userId,
        tokenData,
        userInfo,
        deviceInfo,
      );

      res.json({
        success: true,
        facebookAccount,
        tokenData,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Facebook callback error:", message);
      res.status(500).json({
        error: message,
      });
    }
  },
);

// Step 2: Get user pages and save to database
facebookRoutes.get(
  "/pages",
  facebookLimiter,
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { access_token, facebook_account_id } = req.query;
      const userId = (req as AuthRequest).user.id;

      // Use the provided token or find the most recent active one from DB
      const pages = await getUserPages(access_token as string, userId);

      // Identify the target account for syncing
      let internalFacebookAccountId: number | null = null;

      if (facebook_account_id) {
        const rawAccountId = String(facebook_account_id).trim();
        const numericAccountId = Number(rawAccountId);

        if (
          Number.isSafeInteger(numericAccountId) &&
          numericAccountId > 0 &&
          numericAccountId <= 2147483647
        ) {
          const accountById = await prisma.facebookAccount.findFirst({
            where: { id: numericAccountId, userId, isActive: true },
            select: { id: true },
          });
          if (accountById) internalFacebookAccountId = accountById.id;
        }

        if (!internalFacebookAccountId) {
          const accountByFacebookUserId =
            await prisma.facebookAccount.findFirst({
              where: { facebookUserId: rawAccountId, userId, isActive: true },
              select: { id: true },
            });
          if (accountByFacebookUserId)
            internalFacebookAccountId = accountByFacebookUserId.id;
        }
      } else {
        // Default to the most recently used/active account for this user
        const recentAccount = await prisma.facebookAccount.findFirst({
          where: { userId, isActive: true },
          orderBy: { lastUsedAt: "desc" },
          select: { id: true },
        });
        if (recentAccount) {
          internalFacebookAccountId = recentAccount.id;
        }
      }

      // Sync pages to DB if we have a valid account identifier
      if (internalFacebookAccountId) {
        await saveFacebookPages(internalFacebookAccountId, pages);
      }

      res.json({ data: pages });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Facebook pages error:", message);
      res.status(500).json({ error: message });
    }
  },
);

// Get specific page details
facebookRoutes.get(
  "/pages/:pageId",
  facebookLimiter,
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { pageId } = req.params;
      const { access_token } = req.query;
      const page = await getPageDetails(pageId, access_token as string);
      res.json(page);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },
);

// Disconnect a page
facebookRoutes.delete(
  "/pages/:pageId",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { pageId } = req.params;
      const userId = (req as AuthRequest).user.id;
      await deactivateFacebookPage(pageId, userId);
      res.json({ success: true, message: "Page disconnected successfully" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  },
);

// Step 3: Create a post on a page (protected route with validation and rate limiting)
facebookRoutes.post(
  "/post",
  facebookLimiter,
  authenticateToken,
  validateFacebookPost,
  async (req: Request, res: Response) => {
    try {
      const { pageId, message, accessToken, imageUrl, facebookAccountId } =
        req.body;

      if (!pageId || !message) {
        return res.status(400).json({
          error: "pageId and message are required",
        });
      }

      const result = await createPost({
        pageId,
        message,
        accessToken,
        imageUrl,
      });

      // Log activity if facebookAccountId is provided, or find one by pageId
      let activityAccountId = facebookAccountId
        ? parseInt(facebookAccountId)
        : null;
      if (!activityAccountId) {
        const page = await prisma.facebookPage.findFirst({
          where: { pageId },
          select: { facebookAccountId: true },
        });
        if (page) activityAccountId = page.facebookAccountId;
      }

      if (activityAccountId) {
        await logFacebookActivity(activityAccountId, "post_created", {
          pageId,
          message,
          imageUrl,
          postId: result.id,
        });
      }

      res.json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Facebook post error:", message);
      res.status(500).json({ error: message });
    }
  },
);

// Step 4: Schedule a post (protected route)
facebookRoutes.post(
  "/schedule",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { pageId, message, accessToken, scheduleTime } = req.body;

      if (!pageId || !message || !scheduleTime) {
        return res.status(400).json({
          error: "pageId, message, and scheduleTime are required",
        });
      }

      const result = await schedulePost({
        pageId,
        message,
        accessToken,
        scheduleTime: parseInt(scheduleTime),
      });

      res.json(result);
    } catch (error: any) {
      console.error("Facebook schedule error:", error.message);
      res.status(500).json({ error: error.message });
    }
  },
);

// Step 4.1: Get page posts (protected route)
facebookRoutes.get(
  "/page-posts/:pageId",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { pageId } = req.params;
      const { access_token } = req.query;

      const result = await getPagePosts(pageId, access_token as string);
      res.json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Facebook page posts error:", message);
      res.status(500).json({ error: message });
    }
  },
);

// Get scheduled posts for a page
facebookRoutes.get(
  "/scheduled-posts/:pageId",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { pageId } = req.params;
      const { access_token } = req.query;

      if (!access_token) {
        return res.status(400).json({ error: "access_token is required" });
      }

      // Re-use current implementation logic directly to avoid another service call if simple
      res.json({ data: [] });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  },
);

// Step 5: Get comments for a post (protected route)
facebookRoutes.get(
  "/comments/:postId",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { postId } = req.params;
      const { access_token } = req.query;

      const result = await getPostComments(postId, access_token as string || "");
      res.json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Facebook comments error:", message);
      res.status(500).json({ error: message });
    }
  },
);

// Step 6: Reply to a comment (protected route)
facebookRoutes.post(
  "/reply/:commentId",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { commentId } = req.params;
      const { message, accessToken } = req.body;

      if (!commentId || !message) {
        return res.status(400).json({
          error: "commentId and message are required",
        });
      }

      const result = await replyToComment({
        commentId,
        message,
        accessToken,
      });

      res.json(result);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Facebook reply error:", message);
      res.status(500).json({ error: message });
    }
  },
);

// Delete a post
facebookRoutes.delete(
  "/post/:postId",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { postId } = req.params;
      const { access_token } = req.query;

      const success = await deleteFacebookPost(postId, access_token as string);
      res.json({ success });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  },
);

// Validate token
facebookRoutes.get(
  "/validate-token",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { access_token } = req.query;
      if (!access_token) {
        return res.status(400).json({ error: "access_token is required" });
      }
      const isValid = await validateAccessToken(access_token as string);
      res.json({ isValid });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  },
);

// New routes for account management and analytics

// Get user's Facebook accounts
facebookRoutes.get(
  "/accounts",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as AuthRequest).user.id;
      const accounts = await getUserFacebookAccounts(userId);
      res.json({ data: accounts });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Get Facebook accounts error:", message);
      res.status(500).json({ error: message });
    }
  },
);

// Get user analytics
facebookRoutes.get(
  "/analytics",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as AuthRequest).user.id;
      const { days = 30 } = req.query;
      const analytics = await getUserAnalytics(
        userId,
        parseInt(days as string),
      );
      res.json({ data: analytics });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Get user analytics error:", message);
      res.status(500).json({ error: message });
    }
  },
);

// Switch device for an account
facebookRoutes.post(
  "/switch-device",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { facebookAccountId, deviceInfo } = req.body;
      const userId = (req as AuthRequest).user.id;

      if (!facebookAccountId || !deviceInfo) {
        return res.status(400).json({
          error: "facebookAccountId and deviceInfo are required",
        });
      }

      // Verify the account belongs to the user
      const account = await getUserFacebookAccounts(userId);
      const targetAccount = account.find(
        (acc) => acc.id === parseInt(facebookAccountId),
      );

      if (!targetAccount) {
        return res.status(404).json({ error: "Facebook account not found" });
      }

      const updatedAccount = await switchDevice(
        parseInt(facebookAccountId),
        deviceInfo,
      );
      res.json({ data: updatedAccount });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Switch device error:", message);
      res.status(500).json({ error: message });
    }
  },
);

// Deactivate Facebook account
facebookRoutes.delete(
  "/accounts/:id",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const userId = (req as AuthRequest).user.id;

      // Verify the account belongs to the user
      const account = await getUserFacebookAccounts(userId);
      const targetAccount = account.find((acc) => acc.id === parseInt(id));

      if (!targetAccount) {
        return res.status(404).json({ error: "Facebook account not found" });
      }

      await deactivateFacebookAccount(parseInt(id));
      res.json({ success: true, message: "Account deactivated successfully" });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Deactivate account error:", message);
      res.status(500).json({ error: message });
    }
  },
);

// Admin routes for analytics and user management
facebookRoutes.get(
  "/admin/analytics",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const user = (req as AuthRequest).user;

      if (user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { days = 30 } = req.query;
      const analytics = await getAdminAnalytics(parseInt(days as string));
      res.json({ data: analytics });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Get admin analytics error:", message);
      res.status(500).json({ error: message });
    }
  },
);

// POST /v1/facebook/pages/:pageId/link-business
facebookRoutes.post(
  "/pages/:pageId/link-business",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as AuthRequest).user.id;
      const { pageId } = req.params;
      const { businessProfileId } = req.body;

      if (!businessProfileId) {
        return res.status(400).json({ error: "businessProfileId is required" });
      }

      // Verify the page belongs to this user
      const page = await prisma.facebookPage.findFirst({
        where: { pageId, facebookAccount: { userId } },
      });

      if (!page) {
        return res.status(404).json({ error: "Page not found" });
      }

      // Verify the business profile belongs to this user
      const businessProfile = await prisma.businessProfile.findFirst({
        where: { id: parseInt(businessProfileId), userId },
      });

      if (!businessProfile) {
        return res.status(404).json({ error: "Business profile not found" });
      }

      const updated = await prisma.facebookPage.update({
        where: { id: page.id },
        data: { businessProfileId: parseInt(businessProfileId) },
      });

      res.json({ success: true, page: updated });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  },
);

// DELETE /v1/facebook/pages/:pageId/unlink-business
facebookRoutes.delete(
  "/pages/:pageId/unlink-business",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as AuthRequest).user.id;
      const { pageId } = req.params;

      // Verify the page belongs to this user
      const page = await prisma.facebookPage.findFirst({
        where: { pageId, facebookAccount: { userId } },
      });

      if (!page) {
        return res.status(404).json({ error: "Page not found" });
      }

      if (!page.businessProfileId) {
        return res
          .status(400)
          .json({ error: "Page is not linked to any business profile" });
      }

      const updated = await prisma.facebookPage.update({
        where: { id: page.id },
        data: { businessProfileId: null },
      });

      res.json({ success: true, page: updated });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  },
);

// Step 7: Update Page Settings (Automation, Modes, etc.)
facebookRoutes.patch(
  "/pages/:pageId/settings",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as AuthRequest).user.id;
      const { pageId } = req.params;
      const { responseMode, commentAutoDmEnabled, commentPublicGreeting } = req.body;

      // Verify the page belongs to this user
      const page = await prisma.facebookPage.findFirst({
        where: { pageId, facebookAccount: { userId } },
      });

      if (!page) {
        return res.status(404).json({ error: "Page not found" });
      }

      const updated = await prisma.facebookPage.update({
        where: { id: page.id },
        data: {
          responseMode: responseMode !== undefined ? responseMode : page.responseMode,
          commentAutoDmEnabled: commentAutoDmEnabled !== undefined ? commentAutoDmEnabled : page.commentAutoDmEnabled,
          commentPublicGreeting: commentPublicGreeting !== undefined ? commentPublicGreeting : page.commentPublicGreeting,
        },
      });

      res.json({ success: true, page: updated });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    }
  },
);

// Step 8: Send a private reply to a specific comment message
facebookRoutes.post(
  "/private-reply/:messageId",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as AuthRequest).user.id;
      const messageId = parseInt(req.params.messageId, 10);
      const { message } = req.body;

      if (!messageId || !message) {
        return res.status(400).json({ error: "messageId and message are required" });
      }

      // 1. Resolve the source message and its conversation
      const sourceMsg = await prisma.conversationMessage.findUnique({
        where: { id: messageId },
        include: { 
          conversation: {
            include: { businessProfile: true }
          } 
        }
      });

      if (!sourceMsg || !sourceMsg.externalId) {
        return res.status(404).json({ error: "Source comment not found or missing externalId" });
      }

      if (sourceMsg.conversation.channel !== "facebook_comment") {
        return res.status(400).json({ error: "Private replies are only supported for Facebook Comments" });
      }

      // 2. Resolve Page Token
      const page = await prisma.facebookPage.findFirst({
        where: { 
          pageId: sourceMsg.conversation.pageId, 
          businessProfileId: sourceMsg.conversation.businessProfileId,
          isActive: true 
        }
      });

      if (!page) {
        return res.status(404).json({ error: "Associated Facebook Page not found" });
      }

      const accessToken = decryptFacebookSecret(page.pageAccessToken);

      // 3. Send Private Reply via Meta API
      const dmRes = await sendPrivateReply({
        commentId: sourceMsg.externalId,
        message,
        accessToken,
        pageId: page.pageId,
        businessProfileId: page.businessProfileId!
      });

      if (!dmRes?.id) {
        throw new Error("Meta API failed to return a message ID for private reply");
      }

      // 4. Save the reply in the Comment Thread
      const saved = await saveMessage(sourceMsg.conversationId, "agent", message, {
        externalId: dmRes.id,
        status: "SENT",
        isPrivate: true,
        origin: "facebook_comment_reply"
      });

      // 5. Selective Mirroring to Messenger Thread
      try {
        const messengerConv = await getOrCreateConversation(
          page.pageId,
          sourceMsg.conversation.senderId,
          page.businessProfileId!,
          { channel: "messenger" }
        );

        const mirrorId = `mirror_${dmRes.id}`;
        const existingMirror = await prisma.conversationMessage.findUnique({
          where: { externalId: mirrorId },
        });

        if (!existingMirror) {
          const mirroredMsg = await saveMessage(messengerConv.id, "agent", message, {
            externalId: mirrorId,
            isPrivate: true,
            origin: "facebook_comment_reply",
            mediaMetadata: {
              origin: "facebook_comment_reply",
              postId: sourceMsg.conversation.postId,
              commentId: sourceMsg.externalId,
            },
          });

          // ELITE TIER: Socket Emit for Mirror Thread (Real-time continuity)
          emitToBusiness(page.businessProfileId!, "new_message", {
            conversationId: messengerConv.id,
            message: mirroredMsg,
          });
          emitToConversation(messengerConv.id, "new_message", {
            message: mirroredMsg,
          });
        }
      } catch (mirrorErr: any) {
        logger.warn("facebook.routes.mirror_failed_soft", { error: mirrorErr.message });
      }

      // 6. Emit to UI
      emitToBusiness(page.businessProfileId!, "new_message", {
        conversationId: sourceMsg.conversationId,
        message: saved,
      });
      emitToConversation(sourceMsg.conversationId, "new_message", {
        message: saved,
      });

      res.json({ success: true, data: saved });
    } catch (error: any) {
      logger.error("facebook.private_reply_failed", { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }
);

export default facebookRoutes;
