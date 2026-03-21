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
  switchDevice,
  deactivateFacebookAccount,
  logFacebookActivity,
  getPagePosts,
} from "../../services/meta/facebook.service";
import { authenticateToken } from "../../middlewares/auth.middleware";
import {
  validateFacebookPost,
  validateFacebookSchedule,
} from "../../middlewares/validation.middleware";
import { facebookLimiter } from "../../middlewares/rateLimit.middleware";
import prisma from "../../config/prisma";

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
      const userId = (req as any).user.id;

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
        `https://graph.facebook.com/me?access_token=${tokenData.access_token}&fields=id,name,email`,
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
    } catch (error: any) {
      console.error("Facebook callback error:", error.message);
      res.status(500).json({
        error: error.message,
      });
    }
  },
);

// Step 2: Get user pages and save to database
facebookRoutes.get(
  "/pages",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { access_token, facebook_account_id } = req.query;
      const userId = (req as any).user.id;

      if (!access_token) {
        return res.status(400).json({ error: "access_token is required" });
      }

      const pages = await getUserPages(access_token as string);

      // If facebook_account_id is provided, save pages to database
      if (facebook_account_id) {
        const rawAccountId = String(facebook_account_id).trim();
        let internalFacebookAccountId: number | null = null;

        // Support either internal account ID (int) or Facebook user ID (string digits).
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
          if (accountById) {
            internalFacebookAccountId = accountById.id;
          }
        }

        if (!internalFacebookAccountId) {
          const accountByFacebookUserId =
            await prisma.facebookAccount.findFirst({
              where: { facebookUserId: rawAccountId, userId, isActive: true },
              select: { id: true },
            });
          if (accountByFacebookUserId) {
            internalFacebookAccountId = accountByFacebookUserId.id;
          }
        }

        if (!internalFacebookAccountId) {
          return res.status(400).json({
            error:
              "Invalid facebook_account_id. Use your internal Facebook account id or facebook user id.",
          });
        }

        await saveFacebookPages(internalFacebookAccountId, pages);
      }

      res.json({ data: pages });
    } catch (error: any) {
      console.error("Facebook pages error:", error.message);
      res.status(500).json({ error: error.message });
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

      if (!pageId || !message || !accessToken) {
        return res.status(400).json({
          error: "pageId, message, and accessToken are required",
        });
      }

      const result = await createPost({
        pageId,
        message,
        accessToken,
        imageUrl,
      });

      // Log activity if facebookAccountId is provided
      if (facebookAccountId) {
        await logFacebookActivity(parseInt(facebookAccountId), "post_created", {
          pageId,
          message,
          imageUrl,
          postId: result.id,
        });
      }

      res.json(result);
    } catch (error: any) {
      console.error("Facebook post error:", error.message);
      res.status(500).json({ error: error.message });
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

      if (!pageId || !message || !accessToken || !scheduleTime) {
        return res.status(400).json({
          error: "pageId, message, accessToken, and scheduleTime are required",
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

      if (!access_token) {
        return res.status(400).json({ error: "access_token is required" });
      }

      const result = await getPagePosts(pageId, access_token as string);
      res.json(result);
    } catch (error: any) {
      console.error("Facebook page posts error:", error.message);
      res.status(500).json({ error: error.message });
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

      if (!access_token) {
        return res.status(400).json({ error: "access_token is required" });
      }

      const result = await getPostComments(postId, access_token as string);
      res.json(result);
    } catch (error: any) {
      console.error("Facebook comments error:", error.message);
      res.status(500).json({ error: error.message });
    }
  },
);

// Step 6: Reply to a comment (protected route)
facebookRoutes.post(
  "/reply",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { commentId, message, accessToken } = req.body;

      if (!commentId || !message || !accessToken) {
        return res.status(400).json({
          error: "commentId, message, and accessToken are required",
        });
      }

      const result = await replyToComment({
        commentId,
        message,
        accessToken,
      });

      res.json(result);
    } catch (error: any) {
      console.error("Facebook reply error:", error.message);
      res.status(500).json({ error: error.message });
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
      const userId = (req as any).user.id;
      const accounts = await getUserFacebookAccounts(userId);
      res.json({ data: accounts });
    } catch (error: any) {
      console.error("Get Facebook accounts error:", error.message);
      res.status(500).json({ error: error.message });
    }
  },
);

// Get user analytics
facebookRoutes.get(
  "/analytics",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id;
      const { days = 30 } = req.query;
      const analytics = await getUserAnalytics(
        userId,
        parseInt(days as string),
      );
      res.json({ data: analytics });
    } catch (error: any) {
      console.error("Get user analytics error:", error.message);
      res.status(500).json({ error: error.message });
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
      const userId = (req as any).user.id;

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
    } catch (error: any) {
      console.error("Switch device error:", error.message);
      res.status(500).json({ error: error.message });
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
      const userId = (req as any).user.id;

      // Verify the account belongs to the user
      const account = await getUserFacebookAccounts(userId);
      const targetAccount = account.find((acc) => acc.id === parseInt(id));

      if (!targetAccount) {
        return res.status(404).json({ error: "Facebook account not found" });
      }

      await deactivateFacebookAccount(parseInt(id));
      res.json({ success: true, message: "Account deactivated successfully" });
    } catch (error: any) {
      console.error("Deactivate account error:", error.message);
      res.status(500).json({ error: error.message });
    }
  },
);

// Admin routes for analytics and user management
facebookRoutes.get(
  "/admin/analytics",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;

      if (user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { days = 30 } = req.query;
      const analytics = await getAdminAnalytics(parseInt(days as string));
      res.json({ data: analytics });
    } catch (error: any) {
      console.error("Get admin analytics error:", error.message);
      res.status(500).json({ error: error.message });
    }
  },
);

// POST /v1/facebook/pages/:pageId/link-business
facebookRoutes.post(
  "/pages/:pageId/link-business",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id;
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
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },
);
export default facebookRoutes;
