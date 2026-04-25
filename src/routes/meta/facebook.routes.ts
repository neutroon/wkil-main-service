import { Router, Request, Response } from "express";
import {
  generateAuthUrl,
  exchangeCodeForToken,
  getUserPages,
  createPost,
  schedulePost,
  getPagePosts,
  getPostComments,
  replyToComment,
  saveFacebookToken,
  saveFacebookPages,
  getUserFacebookAccounts,
  getUserAnalytics,
  getAdminAnalytics,
  deactivateFacebookAccount,
  logFacebookActivity,
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
import { logger } from "../../utils/logger";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { 
  facebookLoginSchema, 
  facebookCallbackSchema, 
  facebookPagesSchema,
  facebookPostSchema,
  facebookScheduleSchema,
  facebookPageIdParamSchema,
  facebookPostIdParamSchema,
  facebookCommentIdParamSchema,
  facebookAnalyticsSchema,
  facebookIdParamSchema,
  facebookLinkBusinessSchema,
  facebookPageSettingsSchema,
  facebookPrivateReplySchema
} from "../../validations/facebook.validation";
import { facebookLimiter } from "../../middlewares/rateLimit.middleware";
import prisma from "../../config/prisma";
import { AppError } from "../../middlewares/errorHandler.middleware";

const facebookRoutes = Router();

// Step 0: Initiate Facebook OAuth flow
facebookRoutes.get(
  "/login", 
  validate(facebookLoginSchema),
  (req: Request, res: Response) => {
    const { redirect_uri } = req.query as any;
    const authUrl = generateAuthUrl({ redirect_uri });
    res.json({ authUrl });
  }
);

// Step 1: Exchange code for user access token and save to database
facebookRoutes.get(
  "/login/callback",
  authenticateToken,
  validate(facebookCallbackSchema),
  async (req: Request, res: Response) => {
    const { code, redirect_uri } = req.query as any;
    const userId = (req as any).user.id;

    const tokenData = await exchangeCodeForToken({
      code,
      redirect_uri,
    });

    // Get user info from Facebook
    const userInfoResponse = await fetch(
      `https://graph.facebook.com/me?access_token=${tokenData.access_token}&fields=id,name,email,picture`,
    );
    const userInfo = await userInfoResponse.json();

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
  }
);

// Step 2: Get user pages and save to database
facebookRoutes.get(
  "/pages",
  facebookLimiter,
  authenticateToken,
  validate(facebookPagesSchema),
  async (req: Request, res: Response) => {
    const { access_token, facebook_account_id } = req.query as any;
    const userId = (req as any).user.id;

    // Use the provided token or find the most recent active one from DB
    const pages = await getUserPages(access_token, userId);

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
  }
);

// Get specific page details
facebookRoutes.get(
  "/pages/:pageId",
  facebookLimiter,
  authenticateToken,
  validate(facebookPageIdParamSchema),
  async (req: Request, res: Response) => {
    const { pageId } = req.params;
    const { access_token } = req.query as any;
    const page = await getPageDetails(pageId, access_token);
    res.json(page);
  }
);

// Disconnect a page
facebookRoutes.delete(
  "/pages/:pageId",
  authenticateToken,
  validate(facebookPageIdParamSchema),
  async (req: Request, res: Response) => {
    const { pageId } = req.params;
    const userId = (req as any).user.id;
    await deactivateFacebookPage(pageId, userId);
    res.json({ success: true, message: "Page disconnected successfully" });
  }
);

// Step 3: Create a post on a page
facebookRoutes.post(
  "/post",
  facebookLimiter,
  authenticateToken,
  validate(facebookPostSchema),
  async (req: Request, res: Response) => {
    const { pageId, message, accessToken, imageUrl, facebookAccountId } = req.body;

    const result = await createPost({
      pageId,
      message,
      accessToken,
      imageUrl,
    });

    // Log activity
    let activityAccountId = facebookAccountId ? parseInt(facebookAccountId as string) : null;
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
  }
);

// Step 4: Schedule a post
facebookRoutes.post(
  "/schedule",
  authenticateToken,
  validate(facebookScheduleSchema),
  async (req: Request, res: Response) => {
    const { pageId, message, accessToken, scheduleTime } = req.body;

    const result = await schedulePost({
      pageId,
      message,
      accessToken,
      scheduleTime,
    });

    res.json(result);
  }
);

// Step 4.1: Get page posts
facebookRoutes.get(
  "/page-posts/:pageId",
  authenticateToken,
  validate(facebookPageIdParamSchema),
  async (req: Request, res: Response) => {
    const { pageId } = req.params;
    const { access_token } = req.query as any;

    const result = await getPagePosts(pageId, access_token);
    res.json(result);
  }
);

// Get scheduled posts for a page
facebookRoutes.get(
  "/scheduled-posts/:pageId",
  authenticateToken,
  validate(facebookPageIdParamSchema),
  async (req: Request, res: Response) => {
    res.json({ data: [] });
  }
);

// Step 5: Get comments for a post
facebookRoutes.get(
  "/comments/:postId",
  authenticateToken,
  validate(facebookPostIdParamSchema),
  async (req: Request, res: Response) => {
    const { postId } = req.params;
    const { access_token } = req.query as any;

    const result = await getPostComments(postId, access_token || "");
    res.json(result);
  }
);

// Step 6: Reply to a comment
facebookRoutes.post(
  "/reply/:commentId",
  authenticateToken,
  validate(facebookCommentIdParamSchema),
  async (req: Request, res: Response) => {
    const { commentId } = req.params;
    const { message, accessToken } = req.body;

    const result = await replyToComment({
      commentId,
      message,
      accessToken,
    });

    res.json(result);
  }
);

// Delete a post
facebookRoutes.delete(
  "/post/:postId",
  authenticateToken,
  validate(facebookPostIdParamSchema),
  async (req: Request, res: Response) => {
    const { postId } = req.params;
    const { access_token } = req.query as any;

    const success = await deleteFacebookPost(postId, access_token);
    res.json({ success });
  }
);

// Validate token
facebookRoutes.get(
  "/validate-token",
  authenticateToken,
  async (req: Request, res: Response) => {
    const { access_token } = req.query as any;
    if (!access_token) {
      throw new AppError("access_token is required", 400);
    }
    const isValid = await validateAccessToken(access_token);
    res.json({ isValid });
  }
);

// Get user's Facebook accounts
facebookRoutes.get(
  "/accounts",
  authenticateToken,
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id;
    const accounts = await getUserFacebookAccounts(userId);
    res.json({ data: accounts });
  }
);

// Get user analytics
facebookRoutes.get(
  "/analytics",
  authenticateToken,
  validate(facebookAnalyticsSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id;
    const { days } = req.query as any;
    const analytics = await getUserAnalytics(userId, days);
    res.json({ data: analytics });
  }
);

// Switch device for an account
facebookRoutes.post(
  "/switch-device",
  authenticateToken,
  async (req: Request, res: Response) => {
    const { facebookAccountId, deviceInfo } = req.body;
    const userId = (req as any).user.id;

    if (!facebookAccountId || !deviceInfo) {
      throw new AppError("facebookAccountId and deviceInfo are required", 400);
    }

    // Verify the account belongs to the user
    const account = await getUserFacebookAccounts(userId);
    const targetAccount = account.find(
      (acc) => acc.id === parseInt(facebookAccountId as string)
    );

    if (!targetAccount) {
      throw new AppError("Facebook account not found", 404);
    }

    const updatedAccount = await switchDevice(
      parseInt(facebookAccountId as string),
      deviceInfo,
    );
    res.json({ data: updatedAccount });
  }
);

// Deactivate Facebook account
facebookRoutes.delete(
  "/accounts/:id",
  authenticateToken,
  validate(facebookIdParamSchema),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const userId = (req as any).user.id;

    // Verify the account belongs to the user
    const account = await getUserFacebookAccounts(userId);
    const targetAccount = account.find((acc) => acc.id === parseInt(id));

    if (!targetAccount) {
      throw new AppError("Facebook account not found", 404);
    }

    await deactivateFacebookAccount(parseInt(id));
    res.json({ success: true, message: "Account deactivated successfully" });
  }
);

// Admin routes for analytics and user management
facebookRoutes.get(
  "/admin/analytics",
  authenticateToken,
  validate(facebookAnalyticsSchema),
  async (req: Request, res: Response) => {
    const user = (req as any).user;

    if (user.role !== "admin") {
      throw new AppError("Admin access required", 403);
    }

    const { days } = req.query as any;
    const analytics = await getAdminAnalytics(days);
    res.json({ data: analytics });
  }
);

// POST /v1/facebook/pages/:pageId/link-business
facebookRoutes.post(
  "/pages/:pageId/link-business",
  authenticateToken,
  validate(facebookPageIdParamSchema),
  validate(facebookLinkBusinessSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id;
    const { pageId } = req.params;
    const { businessProfileId } = req.body;

    // Verify the page belongs to this user
    const page = await prisma.facebookPage.findFirst({
      where: { pageId, facebookAccount: { userId } },
    });

    if (!page) {
      throw new AppError("Page not found", 404);
    }

    // Verify the business profile belongs to this user
    const businessProfile = await prisma.businessProfile.findFirst({
      where: { id: businessProfileId, userId },
    });

    if (!businessProfile) {
      throw new AppError("Business profile not found", 404);
    }

    const updated = await prisma.facebookPage.update({
      where: { id: page.id },
      data: { businessProfileId },
    });

    res.json({ success: true, page: updated });
  }
);

// DELETE /v1/facebook/pages/:pageId/unlink-business
facebookRoutes.delete(
  "/pages/:pageId/unlink-business",
  authenticateToken,
  validate(facebookPageIdParamSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id;
    const { pageId } = req.params;

    // Verify the page belongs to this user
    const page = await prisma.facebookPage.findFirst({
      where: { pageId, facebookAccount: { userId } },
    });

    if (!page) {
      throw new AppError("Page not found", 404);
    }

    if (!page.businessProfileId) {
      throw new AppError("Page is not linked to any business profile", 400);
    }

    const updated = await prisma.facebookPage.update({
      where: { id: page.id },
      data: { businessProfileId: null },
    });

    res.json({ success: true, page: updated });
  }
);

// Step 7: Update Page Settings
facebookRoutes.patch(
  "/pages/:pageId/settings",
  authenticateToken,
  validate(facebookPageIdParamSchema),
  validate(facebookPageSettingsSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id;
    const { pageId } = req.params;
    const { responseMode, commentAutoDmEnabled, commentPublicGreeting } = req.body;

    // Verify the page belongs to this user
    const page = await prisma.facebookPage.findFirst({
      where: { pageId, facebookAccount: { userId } },
    });

    if (!page) {
      throw new AppError("Page not found", 404);
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
  }
);

// Step 8: Send a private reply to a specific comment message
facebookRoutes.post(
  "/private-reply/:messageId",
  authenticateToken,
  validate(facebookPrivateReplySchema),
  async (req: Request, res: Response) => {
    const messageId = parseInt(req.params.messageId as any, 10);
    const { message } = req.body;

    // 1. Resolve the source message and its conversation
    const sourceMsg = await prisma.conversationMessage.findUnique({
      where: { id: messageId },
      include: {
        conversation: {
          include: { businessProfile: true },
        },
      },
    });

    if (!sourceMsg || !sourceMsg.externalId) {
      throw new AppError("Source comment not found or missing externalId", 404);
    }

    if (sourceMsg.conversation.channel !== "facebook_comment") {
      throw new AppError("Private replies are only supported for Facebook Comments", 400);
    }

    // 2. Resolve Page Token
    const page = await prisma.facebookPage.findFirst({
      where: {
        pageId: sourceMsg.conversation.pageId,
        businessProfileId: sourceMsg.conversation.businessProfileId,
        isActive: true,
      },
    });

    if (!page) {
      throw new AppError("Associated Facebook Page not found", 404);
    }

    const accessToken = decryptFacebookSecret(page.pageAccessToken);

    // 3. Send Private Reply via Meta API
    const dmRes = await sendPrivateReply({
      commentId: sourceMsg.externalId,
      message,
      accessToken,
      pageId: page.pageId,
      businessProfileId: page.businessProfileId!,
    });

    if (!dmRes?.id) {
      throw new AppError("Meta API failed to return a message ID for private reply", 502);
    }

    // 4. Save the reply in the Comment Thread
    const saved = await saveMessage(
      sourceMsg.conversationId,
      "agent",
      message,
      {
        externalId: dmRes.id,
        status: "SENT",
        isPrivate: true,
        origin: "facebook_comment_reply",
      },
    );

    // 5. Selective Mirroring to Messenger Thread
    try {
      const { mirrorCommentReplyToMessenger } = await import("../../services/meta/metaDelivery.service");
      await mirrorCommentReplyToMessenger({
        pageId: page.pageId,
        senderId: sourceMsg.conversation.senderId,
        businessProfileId: page.businessProfileId!,
        messageId: dmRes.id,
        content: message,
        postId: sourceMsg.conversation.postId ?? undefined,
        commentId: sourceMsg.externalId ?? undefined,
        role: "agent",
      });
    } catch (mirrorErr: any) {
      logger.warn("facebook.routes.mirror_failed_soft", {
        error: mirrorErr.message,
      });
    }

    res.json({ success: true, data: saved });
  }
);

export default facebookRoutes;
