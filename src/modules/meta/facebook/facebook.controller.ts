import { Request, Response } from "express";
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
} from "./facebook.service";
import { saveMessage } from "../core/conversation.service";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { logger } from "@utils/logger";
import prisma from "@config/prisma";
import { AppError } from "@middlewares/errorHandler.middleware";

export class FacebookController {
  /**
   * GET /v1/facebook/login
   */
  async login(req: Request, res: Response) {
    const { redirect_uri } = req.query as any;
    const authUrl = generateAuthUrl({ redirect_uri });
    return res.json({ authUrl });
  }

  /**
   * GET /v1/facebook/login/callback
   */
  async callback(req: Request, res: Response) {
    const { code, redirect_uri } = req.query as any;
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

    return res.json({ success: true, facebookAccount, tokenData });
  }

  /**
   * GET /v1/facebook/pages
   */
  async listPages(req: Request, res: Response) {
    const { access_token, facebook_account_id } = req.query as any;
    const userId = (req as any).user.id;

    const pages = await getUserPages(access_token, userId);

    if (facebook_account_id) {
      await saveFacebookPages(facebook_account_id, pages);
    }

    return res.json({ data: pages });
  }

  /**
   * GET /v1/facebook/pages/:pageId
   */
  async getPageDetails(req: Request, res: Response) {
    const { pageId } = req.params;
    const { access_token } = req.query as any;
    const page = await getPageDetails(pageId, access_token);
    return res.json(page);
  }

  /**
   * DELETE /v1/facebook/pages/:pageId
   */
  async disconnectPage(req: Request, res: Response) {
    const { pageId } = req.params;
    const userId = (req as any).user.id;
    await deactivateFacebookPage(pageId, userId);
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
    const result = await getPagePosts(pageId, access_token);
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
    const result = await replyToComment({ commentId, message, accessToken });
    return res.json(result);
  }

  /**
   * DELETE /v1/facebook/post/:postId
   */
  async deletePost(req: Request, res: Response) {
    const { postId } = req.params;
    const { access_token } = req.query as any;
    const success = await deleteFacebookPost(postId, access_token);
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
      where: { pageId, facebookAccount: { userId } },
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

    return res.json({ success: true, page: updated });
  }

  /**
   * DELETE /v1/facebook/pages/:pageId/unlink-business
   */
  async unlinkBusiness(req: Request, res: Response) {
    const userId = (req as any).user.id;
    const { pageId } = req.params;

    const page = await prisma.facebookPage.findFirst({
      where: { pageId, facebookAccount: { userId } },
    });
    if (!page) throw new AppError("Page not found", 404);
    if (!page.businessProfileId) throw new AppError("Page is not linked", 400);

    const updated = await prisma.facebookPage.update({
      where: { id: page.id },
      data: { businessProfileId: null },
    });

    return res.json({ success: true, page: updated });
  }

  /**
   * PATCH /v1/facebook/pages/:pageId/settings
   */
  async updateSettings(req: Request, res: Response) {
    const userId = (req as any).user.id;
    const { pageId } = req.params;
    const { responseMode, commentAutoDmEnabled, commentPublicGreeting } = req.body;

    const page = await prisma.facebookPage.findFirst({
      where: { pageId, facebookAccount: { userId } },
    });
    if (!page) throw new AppError("Page not found", 404);

    const updated = await prisma.facebookPage.update({
      where: { id: page.id },
      data: {
        responseMode: responseMode !== undefined ? responseMode : page.responseMode,
        commentAutoDmEnabled: commentAutoDmEnabled !== undefined ? commentAutoDmEnabled : page.commentAutoDmEnabled,
        commentPublicGreeting: commentPublicGreeting !== undefined ? commentPublicGreeting : page.commentPublicGreeting,
      },
    });

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






