import { z } from "zod";

/**
 * Facebook OAuth Login Schema
 */
export const facebookLoginSchema = z.object({
  query: z.object({
    redirect_uri: z.string().url("redirect_uri must be a valid URL"),
    state: z.string().min(8).max(256).optional(),
  }),
});

/**
 * Facebook OAuth Callback Schema
 */
export const facebookCallbackSchema = z.object({
  body: z.object({
    code: z.string().min(1, "code is required"),
    redirect_uri: z.string().url("redirect_uri must be a valid URL"),
  }),
});

/**
 * Facebook JS SDK callback schema.
 */
export const facebookSdkCallbackSchema = z.object({
  body: z.object({
    accessToken: z.string().min(1, "accessToken is required"),
    userId: z.string().optional(),
    expiresIn: z.coerce.number().int().positive().optional(),
    grantedScopes: z.string().optional(),
    signedRequest: z.string().optional(),
  }),
});

/**
 * Facebook Pages Fetch Schema
 */
export const facebookPagesSchema = z.object({
  query: z.object({
    access_token: z.string().optional(),
    facebook_account_id: z.coerce.number().optional(),
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
    facebookAccountId: z.coerce.number().optional(),
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
    scheduleTime: z.coerce.number(),
  }),
});

/**
 * Facebook Analytics Query Schema
 */
export const facebookAnalyticsSchema = z.object({
  query: z.object({
    days: z.coerce.number().optional().default(30),
  }),
});

/**
 * Facebook Business Linking Schema
 */
export const facebookLinkBusinessSchema = z.object({
  body: z.object({
    businessProfileId: z.coerce.number(),
  }),
});

/**
 * Facebook Page Settings Schema
 */
export const facebookPageSettingsSchema = z.object({
  body: z.object({
    commentAutoDmEnabled: z.boolean().optional(),
    commentPublicGreeting: z.string().optional(),
  }),
});

/**
 * Facebook Private Reply Schema
 */
export const facebookPrivateReplySchema = z.object({
  params: z.object({
    messageId: z.coerce.number(),
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
    id: z.coerce.number(),
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
