import { Request, Response } from "express";
import {
  generateAuthUrl,
  exchangeCodeForToken,
  prepareSdkFacebookToken,
  createPost,
  schedulePost,
  getPagePosts,
  getPostComments,
  replyToComment,
  saveFacebookToken,
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
  decryptFacebookPageForResponse,
} from "./facebook.service";
import { saveMessage } from "../core/conversation.service";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { logger } from "@utils/logger";
import prisma from "@config/prisma";
import { AppError } from "@middlewares/errorHandler.middleware";
import { invalidateIdentityCache, invalidateFacebookPageCache } from "../core/webhookCache.service";
import { createBullMqJobId, metaExpressQueue } from "../core/meta.queue";

export class FacebookController {
  /**
   * GET /v1/facebook/login
   */
  async login(req: Request, res: Response) {
    const { redirect_uri, state } = req.query as any;
    const authUrl = generateAuthUrl({ redirect_uri, state });
    return res.json({ authUrl });
  }

  /**
   * POST /v1/facebook/login/callback
   */
  async callback(req: Request, res: Response) {
    const { code, redirect_uri } = req.body;
    const userId = (req as any).user.id;

    const tokenData = await exchangeCodeForToken({ code, redirect_uri });

    const userInfoResponse = await fetch(
      `https://graph.facebook.com/me?access_token=${tokenData.access_token}&fields=id,name,email,picture`,
    );
    const userInfo = await userInfoResponse.json();

    const deviceInfo = {
      userAgent: req.get("User-Agent") || "",
      platform: req.get("sec-ch-ua-platform") || "Unknown",
      browser: req.get("sec-ch-ua") || "Unknown",
      device: req.get("sec-ch-ua-mobile") === "?1" ? "Mobile" : "Desktop",
    };

    const facebookAccount = await saveFacebookToken(userId, tokenData, userInfo, deviceInfo);

    // Hardening: Sanitize the account object and remove raw tokenData from response
    // to ensure no sensitive tokens (even encrypted ones) reach the frontend.
    const { accessToken, refreshToken, ...sanitizedAccount } = facebookAccount as any;

    return res.json({ 
      success: true, 
      facebookAccount: sanitizedAccount
    });
  }

  /**
   * POST /v1/facebook/login/sdk
   */
  async sdkCallback(req: Request, res: Response) {
    const { accessToken, userId, expiresIn, grantedScopes } = req.body;
    const ownerUserId = (req as any).user.id;

    const tokenData = await prepareSdkFacebookToken({
      accessToken,
      userId,
      expiresIn,
      grantedScopes,
    });

    const userInfoResponse = await fetch(
      `https://graph.facebook.com/me?access_token=${tokenData.access_token}&fields=id,name,email,picture`,
    );
    const userInfo = await userInfoResponse.json();

    if (!userInfo?.id) {
      throw new AppError("Unable to read Facebook user profile", 502);
    }

    const deviceInfo = {
      userAgent: req.get("User-Agent") || "",
      platform: req.get("sec-ch-ua-platform") || "Unknown",
      browser: req.get("sec-ch-ua") || "Unknown",
      device: req.get("sec-ch-ua-mobile") === "?1" ? "Mobile" : "Desktop",
    };

    const facebookAccount = await saveFacebookToken(
      ownerUserId,
      tokenData,
      userInfo,
      deviceInfo,
    );
    const { accessToken: _accessToken, refreshToken: _refreshToken, ...sanitizedAccount } =
      facebookAccount as any;

    return res.json({
      success: true,
      facebookAccount: sanitizedAccount,
    });
  }

  /**
   * GET /v1/facebook/pages
   * Reads pages from the database only. Sync is handled in the background (T2).
   * Security: pageAccessToken is NEVER returned to the frontend.
   */
  async listPages(req: Request, res: Response) {
    const userId = (req as any).user.id;

    const accounts = await prisma.facebookAccount.findMany({
      where: { userId, isActive: true },
      include: {
        pages: {
          where: { isActive: true },
          orderBy: { lastUsedAt: "desc" },
        },
      },
    });

    const allPages = accounts.flatMap((acc) =>
      acc.pages.map((p) => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { pageAccessToken, ...safeFields } = p;
        
        // T5 Auto-trigger: if page is unhealthy, retry subscription in background
        if (p.webhookStatus === "FAILED" || p.webhookStatus === "PENDING") {
          metaExpressQueue.add("webhook_subscription", {
            type: "webhook_subscription",
            payload: { pageId: p.pageId },
          }, { 
            jobId: createBullMqJobId("webhook-sub-auto", p.pageId) // Deduplicate to avoid queue flood on rapid refreshes
          }).catch(() => {});
        }

        return safeFields;
      })
    );

    return res.json(allPages);
  }

  /**
   * POST /v1/facebook/pages/sync
   * Triggers background sync of all pages + auto-retries FAILED/PENDING webhook subscriptions.
   */
  async syncPages(req: Request, res: Response) {
    const userId = (req as any).user.id;

    const accounts = await prisma.facebookAccount.findMany({
      where: { userId, isActive: true },
      select: { id: true },
    });

    if (accounts.length === 0) {
      return res.status(404).json({ error: "No connected Facebook accounts found." });
    }

    let webhookRetryCount = 0;

    for (const account of accounts) {
      // 1. Enqueue full page sync from Facebook Graph API
      metaExpressQueue.add("sync_facebook_pages", {
        type: "sync_facebook_pages",
        payload: { facebookAccountId: account.id },
      }).catch((err) => logger.error("facebook.sync_trigger.failed", { accountId: account.id, error: err.message }));

      // 2. T5: Auto-retry webhook subscriptions for pages in FAILED or PENDING state
      const unhealthyPages = await prisma.facebookPage.findMany({
        where: {
          facebookAccountId: account.id,
          isActive: true,
          webhookStatus: { in: ["FAILED", "PENDING"] },
        },
        select: { pageId: true },
      });

      for (const page of unhealthyPages) {
        metaExpressQueue.add("webhook_subscription", {
          type: "webhook_subscription",
          payload: { pageId: page.pageId },
        }).catch(() => {});
        webhookRetryCount++;
      }
    }

    logger.info("facebook.sync_trigger.dispatched", {
      accounts: accounts.length,
      webhookRetries: webhookRetryCount,
    });

    return res.json({
      success: true,
      message: "Sync started in background.",
      webhookRetries: webhookRetryCount,
    });
  }

  /**
   * GET /v1/facebook/pages/:pageId
   */
  async getPageDetails(req: Request, res: Response) {
    const { pageId } = req.params;
    const { access_token } = req.query as any;
    const page = await getPageDetails(pageId, access_token || undefined);
    return res.json(page);
  }

  /**
   * DELETE /v1/facebook/pages/:pageId
   */
  async disconnectPage(req: Request, res: Response) {
    const { pageId } = req.params;
    const userId = (req as any).user.id;
    await deactivateFacebookPage(pageId, userId);
    // Bust both the webhook presence cache and the identity resolution cache
    await Promise.all([
      invalidateFacebookPageCache(pageId).catch(() => {}),
      invalidateIdentityCache("messenger", pageId).catch(() => {}),
    ]);
    return res.json({ success: true, message: "Page disconnected successfully" });
  }

  /**
   * POST /v1/facebook/post
   */
  async createPost(req: Request, res: Response) {
    const { pageId, message, accessToken, imageUrl, facebookAccountId } = req.body;

    const result = await createPost({ pageId, message, accessToken, imageUrl });

    let activityAccountId = facebookAccountId;
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

    return res.json(result);
  }

  /**
   * POST /v1/facebook/schedule
   */
  async schedulePost(req: Request, res: Response) {
    const { pageId, message, accessToken, scheduleTime } = req.body;
    const result = await schedulePost({ pageId, message, accessToken, scheduleTime });
    return res.json(result);
  }

  /**
   * GET /v1/facebook/page-posts/:pageId
   */
  async getPagePosts(req: Request, res: Response) {
    const { pageId } = req.params;
    const { access_token } = req.query as any;
    const result = await getPagePosts(pageId, access_token || undefined);
    return res.json(result);
  }

  /**
   * GET /v1/facebook/comments/:postId
   */
  async getComments(req: Request, res: Response) {
    const { postId } = req.params;
    const { access_token } = req.query as any;
    const result = await getPostComments(postId, access_token || undefined);
    return res.json(result);
  }

  /**
   * POST /v1/facebook/reply/:commentId
   */
  async replyToComment(req: Request, res: Response) {
    const { commentId } = req.params;
    const { message, accessToken } = req.body;
    const result = await replyToComment({ commentId, message, accessToken: accessToken || undefined });
    return res.json(result);
  }

  /**
   * DELETE /v1/facebook/post/:postId
   */
  async deletePost(req: Request, res: Response) {
    const { postId } = req.params;
    const { access_token } = req.query as any;
    const success = await deleteFacebookPost(postId, access_token || undefined);
    return res.json({ success });
  }

  /**
   * GET /v1/facebook/validate-token
   */
  async validateToken(req: Request, res: Response) {
    const { access_token } = req.query as any;
    if (!access_token) throw new AppError("access_token is required", 400);
    const isValid = await validateAccessToken(access_token);
    return res.json({ isValid });
  }

  /**
   * GET /v1/facebook/accounts
   */
  async listAccounts(req: Request, res: Response) {
    const userId = (req as any).user.id;
    const accounts = await getUserFacebookAccounts(userId);
    return res.json({ data: accounts });
  }

  /**
   * GET /v1/facebook/analytics
   */
  async getAnalytics(req: Request, res: Response) {
    const userId = (req as any).user.id;
    const { days } = req.query as any;
    const analytics = await getUserAnalytics(userId, days);
    return res.json({ data: analytics });
  }

  /**
   * POST /v1/facebook/switch-device
   */
  async switchDevice(req: Request, res: Response) {
    const { facebookAccountId, deviceInfo } = req.body;
    const userId = (req as any).user.id;

    if (!facebookAccountId || !deviceInfo) {
      throw new AppError("facebookAccountId and deviceInfo are required", 400);
    }

    const accounts = await getUserFacebookAccounts(userId);
    const targetAccount = accounts.find((acc) => acc.id === facebookAccountId);
    if (!targetAccount) throw new AppError("Facebook account not found", 404);

    const updatedAccount = await switchDevice(facebookAccountId, deviceInfo);
    return res.json({ data: updatedAccount });
  }

  /**
   * DELETE /v1/facebook/accounts/:id
   */
  async deactivateAccount(req: Request, res: Response) {
    const { id } = req.params as any;
    const userId = (req as any).user.id;

    const accounts = await getUserFacebookAccounts(userId);
    const targetAccount = accounts.find((acc) => acc.id === id);
    if (!targetAccount) throw new AppError("Facebook account not found", 404);

    await deactivateFacebookAccount(id);
    return res.json({ success: true, message: "Account deactivated successfully" });
  }

  /**
   * GET /v1/facebook/admin/analytics
   */
  async adminGetAnalytics(req: Request, res: Response) {
    const user = (req as any).user;
    if (user.role !== "admin") throw new AppError("Admin access required", 403);

    const { days } = req.query as any;
    const analytics = await getAdminAnalytics(days);
    return res.json({ data: analytics });
  }

  /**
   * POST /v1/facebook/pages/:pageId/link-business
   */
  async linkBusiness(req: Request, res: Response) {
    const userId = (req as any).user.id;
    const { pageId } = req.params;
    const { businessProfileId } = req.body;

    const page = await prisma.facebookPage.findFirst({
      where: { pageId, facebookAccount: { userId }, isActive: true },
      orderBy: { updatedAt: "desc" },
    });
    if (!page) throw new AppError("Page not found", 404);

    const businessProfile = await prisma.businessProfile.findFirst({
      where: { id: businessProfileId, userId },
    });
    if (!businessProfile) throw new AppError("Business profile not found", 404);

    const updated = await prisma.facebookPage.update({
      where: { id: page.id },
      data: { businessProfileId },
    });

    // Invalidate routing and identity caches — businessProfile reference has changed.
    await Promise.all([
      invalidateFacebookPageCache(pageId).catch(() => {}),
      invalidateIdentityCache("messenger", pageId).catch(() => {}),
    ]);

    return res.json({ success: true, page: updated });
  }

  /**
   * DELETE /v1/facebook/pages/:pageId/unlink-business
   */
  async unlinkBusiness(req: Request, res: Response) {
    const userId = (req as any).user.id;
    const { pageId } = req.params;

    const page = await prisma.facebookPage.findFirst({
      where: { pageId, facebookAccount: { userId }, isActive: true },
      orderBy: { updatedAt: "desc" },
    });
    if (!page) throw new AppError("Page not found", 404);
    if (!page.businessProfileId) {
      return res.json({ success: true, page });
    }

    const updated = await prisma.facebookPage.update({
      where: { id: page.id },
      data: { businessProfileId: null },
    });

    // Invalidate routing and identity caches — businessProfile reference has been removed.
    await Promise.all([
      invalidateFacebookPageCache(pageId).catch(() => {}),
      invalidateIdentityCache("messenger", pageId).catch(() => {}),
    ]);

    return res.json({ success: true, page: updated });
  }

  /**
   * PATCH /v1/facebook/pages/:pageId/settings
   */
  async updateSettings(req: Request, res: Response) {
    const userId = (req as any).user.id;
    const { pageId } = req.params;
    const { commentAutoDmEnabled, commentPublicGreeting } = req.body;

    const page = await prisma.facebookPage.findFirst({
      where: { pageId, facebookAccount: { userId }, isActive: true },
      orderBy: { updatedAt: "desc" },
    });
    if (!page) throw new AppError("Page not found", 404);

    const updated = await prisma.facebookPage.update({
      where: { id: page.id },
      data: {
        commentAutoDmEnabled: commentAutoDmEnabled !== undefined ? commentAutoDmEnabled : page.commentAutoDmEnabled,
        commentPublicGreeting: commentPublicGreeting !== undefined ? commentPublicGreeting : page.commentPublicGreeting,
      },
    });
    if (commentAutoDmEnabled !== undefined) {
      await prisma.user.updateMany({
        where: { id: userId, setupAgentConfiguredAt: null },
        data: { setupAgentConfiguredAt: new Date() },
      });
    }

    // Invalidate identity cache — page settings are cached in the processor
    await invalidateIdentityCache("messenger", pageId).catch(() => {});

    return res.json({ success: true, page: updated });
  }

  /**
   * POST /v1/facebook/private-reply/:messageId
   */
  async sendPrivateReply(req: Request, res: Response) {
    const { messageId } = req.params as any;
    const { message } = req.body;

    const sourceMsg = await prisma.conversationMessage.findUnique({
      where: { id: messageId },
      include: {
        conversation: { include: { businessProfile: true } },
      },
    });

    if (!sourceMsg || !sourceMsg.externalId) throw new AppError("Source comment not found", 404);
    if (sourceMsg.conversation.channel !== "facebook_comment") throw new AppError("Invalid channel", 400);

    const page = await prisma.facebookPage.findFirst({
      where: {
        pageId: sourceMsg.conversation.pageId,
        businessProfileId: sourceMsg.conversation.businessProfileId,
        isActive: true,
      },
    });
    if (!page) throw new AppError("Page not found", 404);

    const accessToken = decryptFacebookSecret(page.pageAccessToken);
    const dmRes = await sendPrivateReply({
      commentId: sourceMsg.externalId,
      message,
      accessToken,
      pageId: page.pageId,
      businessProfileId: page.businessProfileId!,
    });

    if (!dmRes?.id) throw new AppError("Meta API failed", 502);

    const saved = await saveMessage(sourceMsg.conversationId, "agent", message, {
      externalId: dmRes.id,
      status: "SENT",
      isPrivate: true,
      origin: "facebook_comment_reply",
    });

    try {
      const { mirrorCommentReplyToMessenger } = await import("../core/metaDelivery.service");
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
    } catch (err: any) {
      logger.warn("facebook.controller.mirror_failed", { error: err.message });
    }

    return res.json({ success: true, data: saved });
  }
}

export const facebookController = new FacebookController();






