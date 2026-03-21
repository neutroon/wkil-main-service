import axios from "axios";
import { PrismaClient } from "@prisma/client";

const FB_API = process.env.FB_API_URL;
const prisma = new PrismaClient();

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

export const generateAuthUrl = (params: FacebookAuthUrlParams): string => {
  if (!process.env.FB_APP_ID) {
    throw new Error("Facebook App ID not configured");
  }

  return `https://www.facebook.com/v25.0/dialog/oauth?client_id=${process.env.FB_APP_ID}&redirect_uri=${params.redirect_uri}&scope=pages_show_list,pages_manage_posts,pages_read_engagement,pages_messaging,pages_manage_metadata&response_type=code`;
};

export const exchangeCodeForToken = async (params: FacebookTokenParams) => {
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

    console.log("Token URL:", tokenUrl);
    console.log("Params:", requestParams);

    const { data } = await axios.post(tokenUrl, null, {
      params: requestParams,
    });
    return data;
  } catch (error: any) {
    console.error(
      "Facebook token exchange error:",
      error.response?.data || error.message,
    );
    throw new Error(error.response?.data?.error?.message || error.message);
  }
};
// -------------------------------------------------------------------------------
// Get user pages using access token
export const getUserPages = async (
  accessToken: string,
): Promise<FacebookPage[]> => {
  try {
    const url = `${FB_API}/me/accounts?access_token=${accessToken}`;
    const { data } = await axios.get(url);
    return data.data;
  } catch (error: any) {
    console.error(
      "Facebook pages error:",
      error.response?.data || error.message,
    );
    throw new Error(error.response?.data?.error?.message || error.message);
  }
};

// publish post on a page
export const createPost = async (params: FacebookPostParams) => {
  try {
    let url: string;
    let postData: any;

    if (params.imageUrl) {
      // Post with image using photos endpoint
      url = `${FB_API}/${params.pageId}/photos`;
      postData = {
        url: params.imageUrl,
        caption: params.message,
        access_token: params.accessToken,
      };
    } else {
      // Regular text post using feed endpoint
      url = `${FB_API}/${params.pageId}/feed`;
      postData = {
        message: params.message,
        access_token: params.accessToken,
      };
    }

    const { data } = await axios.post(url, postData);
    return data;
  } catch (error: any) {
    console.error(
      "Facebook post error:",
      error.response?.data || error.message,
    );
    throw new Error(error.response?.data?.error?.message || error.message);
  }
};

export const schedulePost = async (
  params: FacebookScheduleParams,
): Promise<{ data: { id: string } }> => {
  try {
    const url = `${FB_API}/${params.pageId}/feed`;
    const postData = {
      message: params.message,
      published: false,
      scheduled_publish_time: params.scheduleTime,
      access_token: params.accessToken,
    };

    const { data } = await axios.post(url, postData);
    return data;
  } catch (error: any) {
    console.error(
      "Facebook schedule error:",
      error.response?.data || error.message,
    );
    throw new Error(error.response?.data?.error?.message || error.message);
  }
};

export const getPagePosts = async (pageId: string, accessToken: string) => {
  try {
    const url = `${FB_API}/${pageId}/posts?access_token=${accessToken}`;
    const { data } = await axios.get(url);
    return data;
  } catch (error: any) {
    console.error(
      "Facebook posts error:",
      error.response?.data || error.message,
    );
    throw new Error(error.response?.data?.error?.message || error.message);
  }
};

export const getPostComments = async (postId: string, accessToken: string) => {
  try {
    const url = `${FB_API}/${postId}/comments?access_token=${accessToken}`;
    const { data } = await axios.get(url);
    return data;
  } catch (error: any) {
    console.error(
      "Facebook comments error:",
      error.response?.data || error.message,
    );
    throw new Error(error.response?.data?.error?.message || error.message);
  }
};

export const replyToComment = async (params: FacebookCommentParams) => {
  try {
    const url = `${FB_API}/${params.commentId}/comments`;
    const postData = {
      message: params.message,
      access_token: params.accessToken,
    };

    const { data } = await axios.post(url, postData);
    return data;
  } catch (error: any) {
    console.error(
      "Facebook reply error:",
      error.response?.data || error.message,
    );
    throw new Error(error.response?.data?.error?.message || error.message);
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
    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000)
      : null;

    const facebookAccount = await prisma.facebookAccount.upsert({
      where: { facebookUserId: userInfo.id },
      update: {
        accessToken: tokenData.access_token,
        tokenType: tokenData.token_type || "bearer",
        expiresAt,
        refreshToken: tokenData.refresh_token,
        scope: tokenData.scope,
        isActive: true,
        lastUsedAt: new Date(),
        deviceInfo: deviceInfo ? JSON.stringify(deviceInfo) : null,
      },
      create: {
        userId,
        facebookUserId: userInfo.id,
        accessToken: tokenData.access_token,
        tokenType: tokenData.token_type || "bearer",
        expiresAt,
        refreshToken: tokenData.refresh_token,
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

    return facebookAccount;
  } catch (error: any) {
    console.error("Save Facebook token error:", error);
    throw new Error("Failed to save Facebook token");
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

    return accounts;
  } catch (error: any) {
    console.error("Get user Facebook accounts error:", error);
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
            pageAccessToken: page.access_token,
            isActive: true,
            lastUsedAt: new Date(),
          },
          create: {
            facebookAccountId,
            pageId: page.id,
            pageName: page.name,
            pageAccessToken: page.access_token,
          },
        });
        await subscribePageToWebhook(page.access_token, page.id);

        return saved;
      }),
    );

    // Log the pages connection activity
    await logFacebookActivity(facebookAccountId, "pages_connected", {
      pagesCount: pages.length,
      pageNames: pages.map((p) => p.name),
    });

    return savedPages;
  } catch (error: any) {
    console.error("Save Facebook pages error:", error);
    throw new Error("Failed to save Facebook pages");
  }
};
async function subscribePageToWebhook(pageAccessToken: string, pageId: string) {
  const response = await fetch(
    `https://graph.facebook.com/v25.0/${pageId}/subscribed_apps?access_token=${pageAccessToken}&subscribed_fields=messages,messaging_postbacks`,
    { method: "POST" },
  );

  const data = await response.json();

  if (!data.success) {
    console.error(`[Messenger] Failed to subscribe page ${pageId}:`, data);
  } else {
    console.log(`[Messenger] Page ${pageId} subscribed to webhook ✅`);
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
  } catch (error: any) {
    console.error("Log Facebook activity error:", error);
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
  } catch (error: any) {
    console.error("Update user analytics error:", error);
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

    return {
      analytics,
      facebookAccounts,
      summary: {
        totalAccounts: facebookAccounts.length,
        totalPages: facebookAccounts.reduce(
          (sum, acc) => sum + acc.pages.length,
          0,
        ),
        totalActivities: facebookAccounts.reduce(
          (sum, acc) => sum + acc.activities.length,
          0,
        ),
        recentActivity: facebookAccounts
          .flatMap((acc) => acc.activities)
          .slice(0, 10),
      },
    };
  } catch (error: any) {
    console.error("Get user analytics error:", error);
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
            include: { user: { select: { name: true, email: true } } },
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
  } catch (error: any) {
    console.error("Get admin analytics error:", error);
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

    return account;
  } catch (error: any) {
    console.error("Switch device error:", error);
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
  } catch (error: any) {
    console.error("Deactivate Facebook account error:", error);
    throw new Error("Failed to deactivate account");
  }
};
