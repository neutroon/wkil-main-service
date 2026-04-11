import axios from "axios";
import prisma from "../../config/prisma";
import { mapFacebookGraphError } from "../../utils/facebookGraphError";
import { logger } from "../../utils/logger";
import {
  decryptFacebookSecret,
  encryptFacebookSecret,
} from "../../utils/tokenCrypto";

const FB_API = process.env.FB_API_URL;

export interface FacebookAuthUrlParams {
  redirect_uri: string;
}

export interface FacebookTokenParams {
  code: string;
  redirect_uri: string;
}

export interface FacebookPage {
  access_token: string;
  category: string;
  category_list: [
    {
      id: string;
      name: string;
    },
  ];
  name: string;
  id: string;
  tasks: string[];
}

export interface FacebookPostParams {
  pageId: string;
  message: string;
  accessToken: string;
  imageUrl?: string;
}

export interface FacebookScheduleParams {
  pageId: string;
  message: string;
  accessToken: string;
  scheduleTime: number;
}

export interface FacebookCommentParams {
  commentId: string;
  message: string;
  accessToken: string;
}

export interface FacebookPrivateReplyParams {
  commentId: string;
  message: string;
  accessToken: string;
}

export interface FacebookTokenData {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export interface FacebookUserInfo {
  id: string;
  name: string;
  email?: string;
}

export interface DeviceInfo {
  userAgent: string;
  platform: string;
  browser: string;
  device: string;
}

export { mapFacebookGraphError } from "../../utils/facebookGraphError";

function decryptFacebookAccountForResponse<
  T extends { accessToken: string; refreshToken: string | null },
>(acc: T): T {
  return {
    ...acc,
    accessToken: decryptFacebookSecret(acc.accessToken),
    refreshToken: acc.refreshToken
      ? decryptFacebookSecret(acc.refreshToken)
      : null,
  };
}

function decryptFacebookPageForResponse<P extends { pageAccessToken: string }>(
  page: P,
): P {
  return {
    ...page,
    pageAccessToken: decryptFacebookSecret(page.pageAccessToken),
  };
}

export const generateAuthUrl = (params: FacebookAuthUrlParams): string => {
  if (!process.env.FB_APP_ID) {
    throw new Error("Facebook App ID not configured");
  }

  const scope = [
    "pages_show_list",
    "pages_manage_posts",
    "pages_read_engagement",
    "pages_messaging",
    "pages_manage_metadata",
    "pages_manage_engagement",
  ];

  return `https://www.facebook.com/v25.0/dialog/oauth?client_id=${process.env.FB_APP_ID}&redirect_uri=${params.redirect_uri}&scope=${scope.join(",")}&response_type=code`;
};

/** 
 * Helper to call Facebook Graph API with exponential backoff retries 
 * for transient errors (Code 1, 2, or 500+ status).
 */
const callGraphApiWithRetry = async <T>(
  operation: string,
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 1000
): Promise<T> => {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const mapped = mapFacebookGraphError(error);
      
      // Facebook transient codes: 1 (Unknown), 2 (Service temporarily unavailable)
      const isTransient = 
        mapped.code === 1 || 
        mapped.code === 2 || 
        (mapped.status && mapped.status >= 500);

      if (isTransient && attempt < maxRetries) {
        const delay = initialDelay * Math.pow(2, attempt);
        logger.warn(`facebook.api.retry.${operation}`, { 
          attempt: attempt + 1, 
          delay, 
          errorCode: mapped.code,
          status: mapped.status 
        });
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
};

export const exchangeCodeForToken = async (params: FacebookTokenParams) => {
  return callGraphApiWithRetry("exchange_token", async () => {
    try {
      if (!FB_API || !process.env.FB_APP_ID || !process.env.FB_APP_SECRET) {
        throw new Error("Missing Facebook configuration");
      }

      const tokenUrl = `${FB_API}/oauth/access_token`;
      const requestParams = {
        client_id: process.env.FB_APP_ID,
        client_secret: process.env.FB_APP_SECRET,
        redirect_uri: params.redirect_uri,
        code: params.code,
      };

      const { data } = await axios.post(tokenUrl, null, {
        params: requestParams,
      });
      return data;
    } catch (error: unknown) {
      const mapped = mapFacebookGraphError(error);
      logger.error("facebook.oauth.token_exchange_failed", mapped);
      throw new Error(mapped.message);
    }
  });
};
// -------------------------------------------------------------------------------
// Get user pages using access token
export const getUserPages = async (
  accessToken?: string,
  userId?: number,
): Promise<FacebookPage[]> => {
  return callGraphApiWithRetry("get_pages", async () => {
    try {
      let token = accessToken;

      if (!token && userId) {
        const account = await prisma.facebookAccount.findFirst({
          where: { userId, isActive: true },
          orderBy: { lastUsedAt: "desc" },
          select: { accessToken: true },
        });
        if (account) {
          token = decryptFacebookSecret(account.accessToken);
        }
      }

      if (!token) {
        throw new Error("Facebook access token not found for user");
      }

      const url = `${FB_API}/me/accounts?access_token=${token}`;
      const { data } = await axios.get(url);
      return data.data;
    } catch (error: unknown) {
      const mapped = mapFacebookGraphError(error);
      logger.error("facebook.pages.fetch_failed", mapped);
      throw new Error(mapped.message);
    }
  });
};

// Helper to get page access token from DB
export const getPageAccessToken = async (pageId: string): Promise<string> => {
  const page = await prisma.facebookPage.findFirst({
    where: { pageId, isActive: true },
    select: { pageAccessToken: true },
  });

  if (!page) {
    throw new Error(`Page with ID ${pageId} not found in database or is inactive.`);
  }

  return decryptFacebookSecret(page.pageAccessToken);
};

// publish post on a page
export const createPost = async (params: FacebookPostParams) => {
  return callGraphApiWithRetry("create_post", async () => {
    try {
      let url: string;
      let postData: any;
      const accessToken = params.accessToken || (await getPageAccessToken(params.pageId));

      if (params.imageUrl) {
        // Post with image using photos endpoint
        url = `${FB_API}/${params.pageId}/photos`;
        postData = {
          url: params.imageUrl,
          caption: params.message,
          access_token: accessToken,
        };
      } else {
        // Regular text post using feed endpoint
        url = `${FB_API}/${params.pageId}/feed`;
        postData = {
          message: params.message,
          access_token: accessToken,
        };
      }

      const { data } = await axios.post(url, postData);
      return data;
    } catch (error: unknown) {
      const mapped = mapFacebookGraphError(error);
      logger.error("facebook.post.create_failed", mapped);
      const codePart = mapped.code !== undefined ? ` (code: ${mapped.code})` : "";
      throw new Error(`${mapped.message}${codePart}`);
    }
  });
};

export const schedulePost = async (
  params: FacebookScheduleParams,
): Promise<{ data: { id: string } }> => {
  try {
    const accessToken = params.accessToken || (await getPageAccessToken(params.pageId));
    const url = `${FB_API}/${params.pageId}/feed`;
    const postData = {
      message: params.message,
      published: false,
      scheduled_publish_time: params.scheduleTime,
      access_token: accessToken,
    };

    const { data } = await axios.post(url, postData);
    return data;
  } catch (error: unknown) {
    const mapped = mapFacebookGraphError(error);
    logger.error("facebook.post.schedule_failed", mapped);
    const codePart = mapped.code !== undefined ? ` (code: ${mapped.code})` : "";
    throw new Error(`${mapped.message}${codePart}`);
  }
};

export const getPagePosts = async (pageId: string, accessToken?: string) => {
  return callGraphApiWithRetry("get_page_posts", async () => {
    try {
      const token = accessToken || (await getPageAccessToken(pageId));
      const url = `${FB_API}/${pageId}/posts?access_token=${token}`;
      const { data } = await axios.get(url);
      return data;
    } catch (error: unknown) {
      const mapped = mapFacebookGraphError(error);
      logger.error("facebook.posts.fetch_failed", mapped);
      throw new Error(mapped.message);
    }
  });
};

export const getPostComments = async (postId: string, accessToken: string) => {
  return callGraphApiWithRetry("get_comments", async () => {
    try {
      const url = `${FB_API}/${postId}/comments?access_token=${accessToken}&fields=id,message,from{id,name},created_time,like_count,comments{id,message,from{id,name},created_time,like_count}`;
      const { data } = await axios.get(url);
      return data;
    } catch (error: unknown) {
      const mapped = mapFacebookGraphError(error);
      logger.error("facebook.comments.fetch_failed", mapped);
      throw new Error(mapped.message);
    }
  });
};

export const replyToComment = async (params: FacebookCommentParams) => {
  try {
    const url = `${FB_API}/${params.commentId}/comments`;
    const accessToken = params.accessToken || (await getPageAccessToken(params.commentId.split("_")[0])); // Fallback logic for comment reply
    const postData = {
      message: params.message,
      access_token: accessToken,
    };

    const { data } = await axios.post(url, postData);
    return data;
  } catch (error: unknown) {
    const mapped = mapFacebookGraphError(error);
    logger.error("facebook.comment.reply_failed", mapped);
    throw new Error(mapped.message);
  }
};

/**
 * Sends a private reply to a Facebook comment.
 * Note: Each comment can only be replied to privately ONCE.
 */
export const sendPrivateReply = async (params: FacebookPrivateReplyParams) => {
  try {
    const url = `${FB_API}/${params.commentId}/private_replies`;
    const accessToken = params.accessToken || (await getPageAccessToken(params.commentId.split("_")[0]));
    
    const postData = {
      message: params.message,
      access_token: accessToken,
    };

    const { data } = await axios.post(url, postData);
    return data;
  } catch (error: unknown) {
    const mapped = mapFacebookGraphError(error);
    logger.error("facebook.comment.private_reply_failed", mapped);
    throw new Error(mapped.message);
  }
};

/**
 * Fetches user profile (name) for a given PSID/UID.
 */
export const getFacebookUserProfile = async (psid: string, pageId: string, accessToken?: string) => {
  try {
    const token = accessToken || (await getPageAccessToken(pageId));
    const url = `${FB_API}/${psid}?fields=name,first_name,last_name&access_token=${token}`;
    const { data } = await axios.get(url);
    return data;
  } catch (error: unknown) {
    const mapped = mapFacebookGraphError(error);
    logger.error("facebook.user_profile.fetch_failed", mapped);
    return null; // Return null instead of throwing to allow "there" fallback
  }
};

// New functions for token management and analytics

export const saveFacebookToken = async (
  userId: number,
  tokenData: FacebookTokenData,
  userInfo: FacebookUserInfo,
  deviceInfo?: DeviceInfo,
) => {
  try {
    const existing = await prisma.facebookAccount.findUnique({
      where: { facebookUserId: userInfo.id },
      select: { userId: true },
    });
    if (existing && existing.userId !== userId) {
      throw new Error(
        "This Facebook account is already linked to another user. Log in as that user or disconnect the account first.",
      );
    }

    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000)
      : null;

    const encAccess = encryptFacebookSecret(tokenData.access_token);
    const encRefresh = tokenData.refresh_token
      ? encryptFacebookSecret(tokenData.refresh_token)
      : null;

    const facebookAccount = await prisma.facebookAccount.upsert({
      where: { facebookUserId: userInfo.id },
      update: {
        accessToken: encAccess,
        tokenType: tokenData.token_type || "bearer",
        expiresAt,
        refreshToken: encRefresh,
        scope: tokenData.scope,
        isActive: true,
        lastUsedAt: new Date(),
        deviceInfo: deviceInfo ? JSON.stringify(deviceInfo) : null,
        userId,
      },
      create: {
        userId,
        facebookUserId: userInfo.id,
        accessToken: encAccess,
        tokenType: tokenData.token_type || "bearer",
        expiresAt,
        refreshToken: encRefresh,
        scope: tokenData.scope,
        deviceInfo: deviceInfo ? JSON.stringify(deviceInfo) : null,
      },
    });

    // Log the connection activity
    await logFacebookActivity(facebookAccount.id, "account_connected", {
      facebookUserId: userInfo.id,
      userName: userInfo.name,
      deviceInfo,
    });

    return decryptFacebookAccountForResponse(facebookAccount);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error("facebook.token.save_failed", { error: msg });
    throw error instanceof Error
      ? error
      : new Error("Failed to save Facebook token");
  }
};

export const getUserFacebookAccounts = async (userId: number) => {
  try {
    const accounts = await prisma.facebookAccount.findMany({
      where: { userId, isActive: true },
      include: {
        pages: {
          where: { isActive: true },
          orderBy: { lastUsedAt: "desc" },
        },
        _count: {
          select: { activities: true },
        },
      },
      orderBy: { lastUsedAt: "desc" },
    });

    return accounts.map((acc) => ({
      ...decryptFacebookAccountForResponse(acc),
      pages: acc.pages.map((p) => decryptFacebookPageForResponse(p)),
    }));
  } catch (error: unknown) {
    logger.error("facebook.accounts.fetch_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Failed to get Facebook accounts");
  }
};

export const saveFacebookPages = async (
  facebookAccountId: number,
  pages: FacebookPage[],
) => {
  try {
    const savedPages = await Promise.all(
      pages.map(async (page) => {
        const saved = await prisma.facebookPage.upsert({
          where: {
            facebookAccountId_pageId: {
              facebookAccountId,
              pageId: page.id,
            },
          },
          update: {
            pageName: page.name,
            pageAccessToken: encryptFacebookSecret(page.access_token),
            isActive: true,
            lastUsedAt: new Date(),
          },
          create: {
            facebookAccountId,
            pageId: page.id,
            pageName: page.name,
            pageAccessToken: encryptFacebookSecret(page.access_token),
          },
        });
        await subscribePageToWebhook(page.access_token, page.id);

        return decryptFacebookPageForResponse(saved);
      }),
    );

    // Log the pages connection activity
    await logFacebookActivity(facebookAccountId, "pages_connected", {
      pagesCount: pages.length,
      pageNames: pages.map((p) => p.name),
    });

    return savedPages;
  } catch (error: unknown) {
    logger.error("facebook.pages.save_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Failed to save Facebook pages");
  }
};
async function subscribePageToWebhook(pageAccessToken: string, pageId: string) {
  const response = await fetch(
    `https://graph.facebook.com/v25.0/${pageId}/subscribed_apps?access_token=${pageAccessToken}&subscribed_fields=messages,messaging_postbacks,feed`,
    { method: "POST" },
  );

  const data = await response.json();

  if (!data.success) {
    logger.warn("facebook.messenger.subscribe_failed", { pageId, data });
  } else {
    logger.info("facebook.messenger.page_subscribed", { pageId });
  }
}

export const logFacebookActivity = async (
  facebookAccountId: number,
  activityType: string,
  activityData?: any,
  facebookPageId?: number,
  success: boolean = true,
  errorMessage?: string,
) => {
  try {
    await prisma.facebookActivity.create({
      data: {
        facebookAccountId,
        facebookPageId,
        activityType,
        activityData,
        success,
        errorMessage,
      },
    });

    // Update analytics
    await updateUserAnalytics(facebookAccountId, activityType);
  } catch (error: unknown) {
    logger.error("facebook.activity.log_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const updateUserAnalytics = async (
  facebookAccountId: number,
  activityType: string,
) => {
  try {
    const account = await prisma.facebookAccount.findUnique({
      where: { id: facebookAccountId },
      select: { userId: true },
    });

    if (!account) return;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const analyticsData: any = {
      userId: account.userId,
      date: today,
    };

    switch (activityType) {
      case "post_created":
        analyticsData.postsCreated = { increment: 1 };
        analyticsData.totalEngagement = { increment: 1 };
        break;
      case "post_scheduled":
        analyticsData.postsScheduled = { increment: 1 };
        break;
      case "comment_replied":
        analyticsData.commentsReplied = { increment: 1 };
        analyticsData.totalEngagement = { increment: 1 };
        break;
      case "pages_connected":
        analyticsData.pagesConnected = { increment: 1 };
        break;
    }

    await prisma.userAnalytics.upsert({
      where: {
        userId_date: {
          userId: account.userId,
          date: today,
        },
      },
      update: analyticsData,
      create: analyticsData,
    });
  } catch (error: unknown) {
    logger.error("facebook.analytics.update_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const getUserAnalytics = async (userId: number, days: number = 30) => {
  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const analytics = await prisma.userAnalytics.findMany({
      where: {
        userId,
        date: { gte: startDate },
      },
      orderBy: { date: "desc" },
    });

    const facebookAccounts = await prisma.facebookAccount.findMany({
      where: { userId, isActive: true },
      include: {
        pages: { where: { isActive: true } },
        activities: {
          where: { createdAt: { gte: startDate } },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    const accountsForApi = facebookAccounts.map((acc) => ({
      ...decryptFacebookAccountForResponse(acc),
      pages: acc.pages.map((p) => decryptFacebookPageForResponse(p)),
      activities: acc.activities,
    }));

    return {
      analytics,
      facebookAccounts: accountsForApi,
      summary: {
        totalAccounts: accountsForApi.length,
        totalPages: accountsForApi.reduce(
          (sum, acc) => sum + acc.pages.length,
          0,
        ),
        totalActivities: accountsForApi.reduce(
          (sum, acc) => sum + acc.activities.length,
          0,
        ),
        recentActivity: accountsForApi
          .flatMap((acc) => acc.activities)
          .slice(0, 10),
      },
    };
  } catch (error: unknown) {
    logger.error("facebook.analytics.user_fetch_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Failed to get user analytics");
  }
};

export const getAdminAnalytics = async (days: number = 30) => {
  try {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const [
      totalUsers,
      activeUsers,
      totalAccounts,
      totalPages,
      recentActivities,
      userAnalytics,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({
        where: {
          facebookAccounts: {
            some: { isActive: true },
          },
        },
      }),
      prisma.facebookAccount.count({
        where: { isActive: true },
      }),
      prisma.facebookPage.count({
        where: { isActive: true },
      }),
      prisma.facebookActivity.findMany({
        where: { createdAt: { gte: startDate } },
        include: {
          facebookAccount: {
            select: {
              id: true,
              userId: true,
              facebookUserId: true,
              isActive: true,
              user: { select: { name: true, email: true } },
            },
          },
          facebookPage: { select: { pageName: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      }),
      prisma.userAnalytics.findMany({
        where: { date: { gte: startDate } },
        include: {
          user: { select: { name: true, email: true } },
        },
        orderBy: { date: "desc" },
      }),
    ]);

    return {
      overview: {
        totalUsers,
        activeUsers,
        totalAccounts,
        totalPages,
        activeRate: totalUsers > 0 ? (activeUsers / totalUsers) * 100 : 0,
      },
      recentActivities,
      userAnalytics,
    };
  } catch (error: unknown) {
    logger.error("facebook.analytics.admin_fetch_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Failed to get admin analytics");
  }
};

export const switchDevice = async (
  facebookAccountId: number,
  newDeviceInfo: DeviceInfo,
) => {
  try {
    const account = await prisma.facebookAccount.update({
      where: { id: facebookAccountId },
      data: {
        deviceInfo: JSON.stringify(newDeviceInfo),
        lastUsedAt: new Date(),
      },
    });

    await logFacebookActivity(facebookAccountId, "device_switched", {
      newDeviceInfo,
    });

    return decryptFacebookAccountForResponse(account);
  } catch (error: unknown) {
    logger.error("facebook.device.switch_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Failed to switch device");
  }
};

export const deactivateFacebookAccount = async (facebookAccountId: number) => {
  try {
    await prisma.facebookAccount.update({
      where: { id: facebookAccountId },
      data: {
        isActive: false,
        pages: {
          updateMany: {
            where: {},
            data: { isActive: false },
          },
        },
      },
    });

    await logFacebookActivity(facebookAccountId, "account_deactivated");
  } catch (error: unknown) {
    logger.error("facebook.account.deactivate_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Failed to deactivate account");
  }
};
