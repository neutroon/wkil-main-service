import { z } from "zod";

/**
 * Facebook OAuth Login Schema
 */
export const facebookLoginSchema = z.object({
  query: z.object({
    redirect_uri: z.string().url("redirect_uri must be a valid URL"),
  }),
});

/**
 * Facebook OAuth Callback Schema
 */
export const facebookCallbackSchema = z.object({
  query: z.object({
    code: z.string().min(1, "code is required"),
    redirect_uri: z.string().url("redirect_uri must be a valid URL"),
  }),
});

/**
 * Facebook Pages Fetch Schema
 */
export const facebookPagesSchema = z.object({
  query: z.object({
    access_token: z.string().optional(),
    facebook_account_id: z.string().optional(),
  }),
});

/**
 * Facebook Post Creation Schema
 */
export const facebookPostSchema = z.object({
  body: z.object({
    pageId: z.string().min(1, "pageId is required"),
    message: z.string().min(1, "message is required"),
    accessToken: z.string().optional(),
    imageUrl: z.string().url().optional().or(z.literal("")),
    facebookAccountId: z.union([z.number(), z.string()]).optional(),
  }),
});

/**
 * Facebook Post Scheduling Schema
 */
export const facebookScheduleSchema = z.object({
  body: z.object({
    pageId: z.string().min(1, "pageId is required"),
    message: z.string().min(1, "message is required"),
    accessToken: z.string().optional(),
    scheduleTime: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]),
  }),
});

/**
 * Facebook Analytics Query Schema
 */
export const facebookAnalyticsSchema = z.object({
  query: z.object({
    days: z.string().regex(/^\d+$/).transform(Number).optional().default(30),
  }),
});

/**
 * Facebook Business Linking Schema
 */
export const facebookLinkBusinessSchema = z.object({
  body: z.object({
    businessProfileId: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]),
  }),
});

/**
 * Facebook Page Settings Schema
 */
export const facebookPageSettingsSchema = z.object({
  body: z.object({
    responseMode: z.string().optional(),
    commentAutoDmEnabled: z.boolean().optional(),
    commentPublicGreeting: z.string().optional(),
  }),
});

/**
 * Facebook Private Reply Schema
 */
export const facebookPrivateReplySchema = z.object({
  params: z.object({
    messageId: z.string().regex(/^\d+$/, "messageId must be numeric").transform(Number),
  }),
  body: z.object({
    message: z.string().min(1, "message is required"),
  }),
});

/**
 * Generic ID Parameter Schemas
 */
export const facebookIdParamSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, "ID must be numeric"),
  }),
});

export const facebookPageIdParamSchema = z.object({
  params: z.object({
    pageId: z.string().min(1, "pageId is required"),
  }),
});

export const facebookPostIdParamSchema = z.object({
  params: z.object({
    postId: z.string().min(1, "postId is required"),
  }),
});

export const facebookCommentIdParamSchema = z.object({
  params: z.object({
    commentId: z.string().min(1, "commentId is required"),
  }),
});
