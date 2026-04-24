import axios from "axios";
import prisma from "../../config/prisma";
import { mapFacebookGraphError } from "../../utils/facebookGraphError";
import { logger } from "../../utils/logger";
import {
  decryptFacebookSecret,
  encryptFacebookSecret,
} from "../../utils/tokenCrypto";
import { invalidateFacebookPageCache } from "./webhookCache.service";

const FB_API = process.env.FB_API_URL;

// ELITE TIER: In-memory cache for post content to avoid redundant Graph API calls
const POST_CONTEXT_CACHE = new Map<string, { content: string; media?: string; expiresAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

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
  followers_count?: number;
  picture?: {
    data: {
      url: string;
    };
  };
  // Automation settings from our DB
  responseMode?: string;
  commentAutoDmEnabled?: boolean;
  commentPublicGreeting?: string;
  isActive?: boolean;
}

export interface FacebookPostParams {
  pageId: string;
  message: string;
  accessToken?: string;
  imageUrl?: string;
}

export interface FacebookScheduleParams {
  pageId: string;
  message: string;
  accessToken?: string;
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

export interface FacebookLikeParams {
  commentId: string;
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
  picture?: {
    data: {
      url: string;
    };
  };
}

export interface DeviceInfo {
  userAgent: string;
  platform: string;
  browser: string;
  device: string;
}

export { mapFacebookGraphError } from "../../utils/facebookGraphError";

/**
 * Validates the health of a Meta Access Token using the /debug_token endpoint.
 * This ensures the token hasn't been revoked or expired.
 */
export async function validateTokenHealth(accessToken: string): Promise<{
  isValid: boolean;
  expiresAt?: Date;
  scopes?: string[];
  error?: string;
}> {
  try {
    const appAccessToken = `${process.env.FB_APP_ID}|${process.env.FB_APP_SECRET}`;
    const response = await axios.get(`${FB_API}/debug_token`, {
      params: {
        input_token: accessToken,
        access_token: appAccessToken,
      },
    });

    const { data } = response.data;
    return {
      isValid: data.is_valid,
      expiresAt: data.data_access_expires_at
        ? new Date(data.data_access_expires_at * 1000)
        : undefined,
      scopes: data.scopes,
    };
  } catch (error: any) {
    logger.error("meta.validate_token_failed", { error: error.message });
    return { isValid: false, error: error.message };
  }
}

/**
 * Updates the validation status of a FacebookAccount, FacebookPage, or WhatsAppAccount.
 */
export async function updateTokenStatus(params: {
  type: "account" | "page" | "whatsapp";
  id: number;
  isValid: boolean;
}) {
  const data = {
    isTokenValid: params.isValid,
    lastValidatedAt: new Date(),
  };

  if (params.type === "account") {
    return prisma.facebookAccount.update({ where: { id: params.id }, data });
  } else if (params.type === "page") {
    return prisma.facebookPage.update({ where: { id: params.id }, data });
  } else {
    return prisma.whatsAppAccount.update({ where: { id: params.id }, data });
  }
}

function decryptFacebookAccountForResponse<
  T extends {
    accessToken: string;
    refreshToken: string | null;
    name?: string | null;
    pictureUrl?: string | null;
  },
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
  initialDelay: number = 1000,
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

      // Facebook throttling codes: 4 (App), 17 (User), 32 (Page), 613 (Custom)
      const isRateLimit = 
        mapped.code === 4 || 
        mapped.code === 17 || 
        mapped.code === 32 || 
        mapped.code === 613;

      if ((isTransient || isRateLimit) && attempt < maxRetries) {
        // For Rate Limits, we use a much more aggressive backoff (Elite Tier)
        const delay = isRateLimit 
          ? (60000 + Math.random() * 60000) * (attempt + 1) // 1-2 mins per retry
          : initialDelay * Math.pow(2, attempt);
        
        logger.warn(`facebook.api.retry.${operation}`, {
          attempt: attempt + 1,
          delay,
          errorCode: mapped.code,
          isRateLimit,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
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
        return [];
      }

      const url = `${FB_API}/me/accounts?access_token=${token}&fields=id,name,access_token,category,followers_count,picture`;
      const { data } = await axios.get(url);
      const graphPages: FacebookPage[] = data.data;

      // If we have a userId, merge database settings (automation mode, etc.)
      if (userId && graphPages.length > 0) {
        const storedPages = await prisma.facebookPage.findMany({
          where: {
            pageId: { in: graphPages.map((p) => p.id) },
            facebookAccount: { userId },
          },
          select: {
            pageId: true,
            responseMode: true,
            commentAutoDmEnabled: true,
            commentPublicGreeting: true,
            isActive: true,
          },
        });

        // Map for fast lookup
        const settingsMap = new Map(storedPages.map((sp) => [sp.pageId, sp]));

        return graphPages.map((gp) => {
          const settings = settingsMap.get(gp.id);
          return {
            ...gp,
            isActive: settings ? settings.isActive : true,
            responseMode: settings?.responseMode,
            commentAutoDmEnabled: settings?.commentAutoDmEnabled,
            commentPublicGreeting: settings?.commentPublicGreeting,
          };
        });
      }

      return graphPages;
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
    orderBy: { updatedAt: "desc" },
    select: { pageAccessToken: true },
  });

  if (!page) {
    throw new Error(
      `Page with ID ${pageId} not found in database or is inactive.`,
    );
  }

  return decryptFacebookSecret(page.pageAccessToken);
};

// publish post on a page
export const createPost = async (params: FacebookPostParams) => {
  return callGraphApiWithRetry("create_post", async () => {
    try {
      let url: string;
      let postData: any;
      const accessToken =
        params.accessToken || (await getPageAccessToken(params.pageId));

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
      const codePart =
        mapped.code !== undefined ? ` (code: ${mapped.code})` : "";
      throw new Error(`${mapped.message}${codePart}`);
    }
  });
};

export const schedulePost = async (
  params: FacebookScheduleParams,
): Promise<{ data: { id: string } }> => {
  try {
    const accessToken =
      params.accessToken || (await getPageAccessToken(params.pageId));
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

/**
 * Get specific page details (proxy)
 */
export const getPageDetails = async (
  pageId: string,
  accessToken?: string,
): Promise<FacebookPage> => {
  return callGraphApiWithRetry("get_page_details", async () => {
    try {
      const token = accessToken || (await getPageAccessToken(pageId));
      const url = `${FB_API}/${pageId}?access_token=${token}&fields=id,name,category,followers_count,picture`;
      const { data } = await axios.get(url);
      const graphPage: FacebookPage = data;

      // Try to find stored settings in our DB
      const storedPage = await prisma.facebookPage.findFirst({
        where: { pageId },
        select: {
          responseMode: true,
          commentAutoDmEnabled: true,
          commentPublicGreeting: true,
        },
      });

      if (storedPage) {
        return {
          ...graphPage,
          responseMode: storedPage.responseMode,
          commentAutoDmEnabled: storedPage.commentAutoDmEnabled,
          commentPublicGreeting: storedPage.commentPublicGreeting,
        };
      }

      return graphPage;
    } catch (error: unknown) {
      const mapped = mapFacebookGraphError(error);
      logger.error("facebook.page.fetch_details_failed", mapped);
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

/**
 * ELITE TIER: Passive ID Scoping
 * Only prefixes the ID if it's a raw numeric string.
 * If the ID already has a prefix (e.g. from an Ad or Crosspost), we trust it.
 */
function scopeCommentId(id: string, pageId?: string): string {
  // If it already has an underscore, it's already scoped (e.g. POSTID_COMMENTID)
  // We MUST trust this prefix, especially for Ads or Crossposts.
  if (id.includes("_")) return id;
  
  // Fallback: If it's a raw ID and we HAVE a pageId, apply the scoping
  if (pageId) {
    return `${pageId}_${id}`;
  }
  
  return id;
}

/**
 * ELITE TIER: Resilient Comment Reply with Token Pivoting.
 * If the current token fails or doesn't match the prefix, we attempt to find 
 * the 'right' token for the content owner in our DB.
 */
export const replyToComment = async (params: FacebookCommentParams & { pageId?: string; businessProfileId?: number }) => {
  const { commentId, message, accessToken, pageId, businessProfileId } = params;
  
  let activeToken = accessToken;
  let activePageId = pageId;

  // ── ELITE TIER: Surgical Token Pivoting ──
  // Only attempt a pivot if we are certain the current pageId is NOT the owner.
  // We check if the prefix matches a DIFFERENT Page we manage.
  if (commentId.includes("_") && businessProfileId) {
    const prefix = commentId.split("_")[0];
    if (prefix !== pageId) {
      const ownerPage = await prisma.facebookPage.findFirst({
        where: { pageId: prefix, businessProfileId, isActive: true },
        select: { pageAccessToken: true, pageId: true }
      });
      
      if (ownerPage) {
        logger.info("facebook.delivery.public_pivot_triggered", { 
          from: pageId, to: ownerPage.pageId, commentId 
        });
        activeToken = decryptFacebookSecret(ownerPage.pageAccessToken);
        activePageId = ownerPage.pageId;
      }
    }
  }

  const scopedId = scopeCommentId(commentId, activePageId);
  try {
    const { data } = await axios.post(
      `${FB_API}/${scopedId}/comments`,
      { message, access_token: activeToken }
    );
    return data;
  } catch (error: any) {
    const mapped = mapFacebookGraphError(error);
    logger.error("facebook.comment.reply_failed", { 
      message: mapped.message, code: mapped.code, status: mapped.status,
      isRetryable: mapped.isRetryable, subcode: mapped.subcode,
      commentId, pageId: activePageId 
    });
    throw new Error(mapped.message);
  }
};

/**
 * Fetches the permalink_url for a Facebook post.
 */
export const getFacebookPostUrl = async (
  postId: string,
  accessToken?: string,
): Promise<string | null> => {
  return callGraphApiWithRetry("get_post_url", async () => {
    try {
      const token =
        accessToken || (await getPageAccessToken(postId.split("_")[0]));
      const url = `${FB_API}/${postId}?fields=permalink_url&access_token=${token}`;
      const { data } = await axios.get(url);
      return data.permalink_url;
    } catch (error: any) {
      logger.error("facebook.post_url.fetch_failed", {
        postId,
        error: error.message,
      });
      return null;
    }
  });
};

/**
 * ELITE TIER: Social Engagement - Liking a comment.
 */
export const likeComment = async (params: FacebookLikeParams & { pageId?: string }) => {
  const { commentId, accessToken, pageId } = params;
  const scopedId = scopeCommentId(commentId, pageId);
  
  try {
    const { data } = await axios.post(
      `${FB_API}/${scopedId}/likes`,
      { access_token: accessToken }
    );
    return data;
  } catch (error: any) {
    const mapped = mapFacebookGraphError(error);
    logger.warn("facebook.comment.like_failed", { 
      message: mapped.message, code: mapped.code, commentId 
    });
    return null;
  }
};

/**
 * ELITE TIER: Fetches text of a specific comment for thread context.
 */
export const getCommentText = async (commentId: string, accessToken: string): Promise<string | null> => {
  try {
    const { data } = await axios.get(
      `${FB_API}/${commentId}?fields=message&access_token=${accessToken}`
    );
    return data.message || null;
  } catch (err: any) {
    logger.warn("facebook.comment.fetch_text_failed", { commentId, error: err.message });
    return null;
  }
};

/**
 * ELITE TIER: Fetches full post context (text + media metadata) with caching.
 */
export const getPostContext = async (
  postId: string,
  accessToken?: string
): Promise<{ content: string; media?: string } | null> => {
  // 1. Check Cache
  const cached = POST_CONTEXT_CACHE.get(postId);
  if (cached && cached.expiresAt > Date.now()) {
    return { content: cached.content, media: cached.media };
  }

  return callGraphApiWithRetry("get_post_context", async () => {
    try {
      const token = accessToken || (await getPageAccessToken(postId.split("_")[0]));
      // Fetch core message and attachments for visual awareness
      const url = `${FB_API}/${postId}?fields=message,attachments{media_type,description}&access_token=${token}`;
      const { data } = await axios.get(url);

      const content = data.message || "";
      let mediaDesc = "";

      if (data.attachments?.data?.[0]) {
        const att = data.attachments.data[0];
        mediaDesc = `[Type: ${att.media_type || "image"}${att.description ? `, Desc: ${att.description}` : ""}]`;
      }

      // 2. Update Cache
      POST_CONTEXT_CACHE.set(postId, {
        content,
        media: mediaDesc,
        expiresAt: Date.now() + CACHE_TTL_MS
      });

      return { content, media: mediaDesc };
    } catch (error: any) {
      logger.error("facebook.post_context.fetch_failed", { postId, error: error.message });
      return null;
    }
  });
};

/**
 * Delete a post from a Facebook page
 */
export const deleteFacebookPost = async (
  postId: string,
  accessToken?: string,
): Promise<boolean> => {
  return callGraphApiWithRetry("delete_post", async () => {
    try {
      // If we don't have an access token, we try to extract pageId from postId (pageId_postId format)
      let token = accessToken;
      if (!token && postId.includes("_")) {
        const pageId = postId.split("_")[0];
        token = await getPageAccessToken(pageId);
      }

      if (!token) {
        throw new Error("Access token required for post deletion");
      }

      const url = `${FB_API}/${postId}?access_token=${token}`;
      await axios.delete(url);
      return true;
    } catch (error: unknown) {
      const mapped = mapFacebookGraphError(error);
      logger.error("facebook.post.delete_failed", mapped);
      return false;
    }
  });
};

/**
 * Validate an access token
 */
export const validateAccessToken = async (
  accessToken: string,
): Promise<boolean> => {
  try {
    const url = `${FB_API}/me?access_token=${accessToken}&fields=id`;
    await axios.get(url);
    return true;
  } catch (error: unknown) {
    return false;
  }
};

/**
 * Sends a private reply to a Facebook comment.
 * Note: Each comment can only be replied to privately ONCE.
 */
/**
 * ELITE TIER: Resilient Private Reply with Token Pivoting.
 * Note: Each comment can only be replied to privately ONCE.
 */
export const sendPrivateReply = async (params: FacebookPrivateReplyParams & { pageId?: string; businessProfileId?: number }) => {
  const { commentId, message, accessToken, pageId, businessProfileId } = params;

  let activeToken = accessToken;
  let activePageId = pageId;

  // ── ELITE TIER: Surgical Token Pivoting ──
  // We prioritize the Page owner of the comment. 
  // For Comments, the prefix is usually the Post ID, not the Page ID.
  // We only pivot if we determine the current token/page is definitely not the owner AND we can find a better match.
  if (commentId.includes("_") && businessProfileId) {
    const parts = commentId.split("_");
    const potentialPageId = parts[0]; 

    // If we're not using the owner's token already, try to find a matching page in our DB.
    if (activePageId !== potentialPageId) {
      const ownerPage = await prisma.facebookPage.findFirst({
        where: { 
          OR: [{ pageId: potentialPageId }, { pageId: activePageId }],
          businessProfileId, 
          isActive: true 
        },
        select: { pageAccessToken: true, pageId: true }
      });
      
      if (ownerPage && ownerPage.pageId !== activePageId) {
        logger.info("facebook.delivery.private_pivot_triggered", { 
          from: activePageId, to: ownerPage.pageId, commentId 
        });
        activeToken = decryptFacebookSecret(ownerPage.pageAccessToken);
        activePageId = ownerPage.pageId;
      }
    }
  }

  const scopedId = scopeCommentId(commentId, activePageId);
  try {
    // ELITE TIER: Modern Messaging API Delivery
    // We transition from the legacy /{comment-id}/private_replies endpoint
    // to the robust /{page-id}/messages endpoint with recipient.comment_id.
    // This is the only endpoint resilient to v17+ App Scoping restrictions.
    const { data } = await axios.post(
      `${FB_API}/me/messages?access_token=${activeToken}`,
      {
        recipient: { comment_id: scopedId },
        message: { text: message }
      }
    );
    
    // DEBUG: Log the raw response from Meta to verify deliverable ID
    logger.info("facebook.delivery.private_success", { 
      commentId, 
      recipient: scopedId,
      messageId: data.message_id
    });
    
    // Map standard Messaging API response (message_id) to the internal expected 'id' key
    return { id: data.message_id, ...data };
  } catch (error: any) {
    const mapped = mapFacebookGraphError(error);
    
    // ELITE TIER: Soft Fail for "Already Replied"
    // Subcode 2018042: "You are trying to reply to a comment that has already been replied to."
    if (mapped.code === 100 && mapped.subcode === 2018042) {
      logger.info("facebook.delivery.private_skip_already_replied", { commentId });
      return { id: "ALREADY_REPLIED", status: "ALREADY_REPLIED" };
    }

    logger.error("facebook.comment.private_reply_failed", { 
      message: mapped.message, code: mapped.code, status: mapped.status,
      isRetryable: mapped.isRetryable, subcode: mapped.subcode,
      commentId, pageId: activePageId 
    });
    throw new Error(mapped.message);
  }
};

/**
 * Fetches user profile (name) for a given PSID/UID.
 */
export const getFacebookUserProfile = async (
  psid: string,
  pageId: string,
  accessToken?: string,
) => {
  try {
    const cleanPsid = psid.trim();
    const token = accessToken || (await getPageAccessToken(pageId));
    const url = `${FB_API}/${cleanPsid}?fields=name,first_name,last_name,picture&access_token=${token}`;
    const { data } = await axios.get(url);
    return data;
  } catch (error: unknown) {
    const mapped = mapFacebookGraphError(error);

    // Check for "Object does not exist" (Code 100) or Permissions (Code 10/200/400 range)
    // We log these as warnings as they are common side-effects of Beta/Dev apps or User Privacy settings.
    // Code 100 is specifically "Object does not exist" which is what the user is seeing.
    if (
      mapped.code === 100 ||
      (mapped.status && mapped.status >= 400 && mapped.status < 500)
    ) {
      logger.warn("facebook.user_profile.fetch_skipped", { psid, ...mapped });
    } else {
      logger.error("facebook.user_profile.fetch_failed", mapped);
    }
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
        name: userInfo.name,
        pictureUrl: userInfo.picture?.data?.url || null,
        pages: {
          updateMany: {
            where: {},
            data: { isActive: true }
          }
        }
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
        name: userInfo.name,
        pictureUrl: userInfo.picture?.data?.url || null,
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
            category: page.category || null,
            pictureUrl: page.picture?.data?.url || null,
            followersCount: page.followers_count || 0,
            lastUsedAt: new Date(),
          },
          create: {
            facebookAccountId,
            pageId: page.id,
            pageName: page.name,
            pageAccessToken: encryptFacebookSecret(page.access_token),
            category: page.category || null,
            pictureUrl: page.picture?.data?.url || null,
            followersCount: page.followers_count || 0,
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

    const updateData: any = {};
    const createData: any = {
      userId: account.userId,
      date: today,
    };

    switch (activityType) {
      case "post_created":
        updateData.postsCreated = { increment: 1 };
        updateData.totalEngagement = { increment: 1 };
        createData.postsCreated = 1;
        createData.totalEngagement = 1;
        break;
      case "post_scheduled":
        updateData.postsScheduled = { increment: 1 };
        createData.postsScheduled = 1;
        break;
      case "comment_replied":
        updateData.commentsReplied = { increment: 1 };
        updateData.totalEngagement = { increment: 1 };
        createData.commentsReplied = 1;
        createData.totalEngagement = 1;
        break;
      case "pages_connected":
        updateData.pagesConnected = { increment: 1 };
        createData.pagesConnected = 1;
        break;
    }

    await prisma.userAnalytics.upsert({
      where: {
        userId_date: {
          userId: account.userId,
          date: today,
        },
      },
      update: updateData,
      create: createData,
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
      creditsAgg,
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
      prisma.businessProfile.aggregate({
        _sum: { monthlyTokensUsed: true }
      }),
    ]);

    const totalCreditsUsed = creditsAgg._sum.monthlyTokensUsed || 0;
    const totalRevenue = totalCreditsUsed * 0.001;

    return {
      overview: {
        totalUsers,
        activeUsers,
        totalAccounts,
        totalPages,
        activeRate: totalUsers > 0 ? (activeUsers / totalUsers) * 100 : 0,
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
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
    const pages = await prisma.facebookPage.findMany({
      where: { facebookAccountId },
      select: { pageId: true },
    });

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

    for (const page of pages) {
      await invalidateFacebookPageCache(page.pageId).catch(() => {});
    }

    await logFacebookActivity(facebookAccountId, "account_deactivated");
  } catch (error: unknown) {
    logger.error("facebook.account.deactivate_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Failed to deactivate Facebook account");
  }
};

export const deactivateFacebookPage = async (
  pageId: string,
  userId: number,
) => {
  try {
    const page = await prisma.facebookPage.findFirst({
      where: { pageId, facebookAccount: { userId } },
      select: { id: true, facebookAccountId: true, pageAccessToken: true },
    });

    if (!page) {
      throw new Error("Page not found or unauthorized");
    }

    // Try to revoke permissions on Facebook directly
    try {
      const account = await prisma.facebookAccount.findFirst({
        where: { id: page.facebookAccountId, isActive: true },
        select: { accessToken: true }
      });

      if (account) {
        const userToken = decryptFacebookSecret(account.accessToken);
        await axios.delete(
          `${FB_API}/${pageId}/permissions?access_token=${userToken}`,
        );
      } else if (page.pageAccessToken) {
        const token = decryptFacebookSecret(page.pageAccessToken);
        await axios.delete(
          `${FB_API}/${pageId}/permissions?access_token=${token}`,
        );
      }
    } catch (err: any) {
      logger.warn("facebook.page.revoke_permission_failed", {
        pageId,
        error: err.message,
      });
    }

    await prisma.facebookPage.update({
      where: { id: page.id },
      data: { isActive: false },
    });

    await invalidateFacebookPageCache(pageId).catch(() => {});

    await logFacebookActivity(page.facebookAccountId, "page_disconnected", {
      pageId,
    });
  } catch (error: unknown) {
    logger.error("facebook.page.deactivate_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error("Failed to disconnect Facebook page");
  }
};
