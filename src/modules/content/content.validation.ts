import { z } from "zod";

/**
 * Generate Post Content Schema
 * POST /v1/content/generate-post
 */
export const generatePostSchema = z.object({
  body: z.object({
    topic: z.string().min(3, "Topic must be at least 3 characters").max(200),
    businessProfileId: z.coerce.number().optional(),
    length: z.enum(["short", "medium", "long"]).optional().default("medium"),
    keywords: z.array(z.string()).optional().default([]),
    context: z.string().max(500, "Context must be less than 500 characters").optional().default(""),
    generateImage: z.boolean().optional().default(false),
  }),
});

/**
 * Generate Content Strategy Schema
 * POST /v1/content/plan/generate-strategy
 */
export const generateStrategySchema = z.object({
  body: z.object({
    businessProfileId: z.coerce.number().optional(),
    contentBriefId: z.coerce.number().optional(),
    startDate: z.string().min(1, "startDate is required"),
    endDate: z.string().min(1, "endDate is required"),
    goals: z.string().optional(),
    currentTrends: z.union([z.string(), z.array(z.string())]).optional(),
  }),
});

const competitorInputSchema = z.object({
  name: z.string().max(120).optional(),
  url: z.string().url().optional(),
});

const socialSampleSchema = z.object({
  competitorName: z.string().max(120).optional(),
  platform: z.string().max(50).optional(),
  url: z.string().url().optional(),
  text: z.string().max(4000).optional(),
});

/**
 * Content Audit Schema
 * POST /v1/content/brief/audit
 */
export const contentAuditSchema = z.object({
  body: z.object({
    businessProfileId: z.coerce.number().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    goal: z.string().max(1000).optional().default(""),
    currentTrends: z.string().max(1000).optional().default(""),
    signalWindowDays: z.coerce.number().int().min(7).max(365).optional().default(90),
    competitorDiscoveryScope: z
      .enum(["PROVIDED_ONLY", "PROVIDED_AND_AI_SEARCH", "AI_DISCOVERY"])
      .optional()
      .default("PROVIDED_AND_AI_SEARCH"),
    competitorAnalysisModes: z
      .array(z.enum(["WEBSITE_SEARCH", "SOCIAL_SAMPLES", "PUBLIC_SOCIAL_SCRAPE"]))
      .optional()
      .default(["WEBSITE_SEARCH"]),
    competitors: z.array(competitorInputSchema).max(10).optional().default([]),
    socialSamples: z.array(socialSampleSchema).max(20).optional().default([]),
  }),
});

const jsonishArray = z.array(z.any()).optional().default([]);

/**
 * Save Content Brief Schema
 * POST /v1/content/brief
 */
export const saveContentBriefSchema = z.object({
  body: z.object({
    businessProfileId: z.coerce.number(),
    sourceAuditId: z.coerce.number().optional(),
    status: z.enum(["draft", "confirmed", "archived"]).optional().default("confirmed"),
    goal: z.string().max(1000).optional(),
    audienceSegments: jsonishArray,
    painPoints: jsonishArray,
    objections: jsonishArray,
    buyingTriggers: jsonishArray,
    offers: jsonishArray,
    proofPoints: jsonishArray,
    cta: z.string().max(500).optional(),
    funnelFocus: z.string().max(500).optional(),
    tonePreferences: z.string().max(1000).optional(),
    forbiddenTopics: jsonishArray,
    competitorInsights: z.any().optional(),
    ownerAnswers: z.any().optional(),
  }),
});

export const contentBriefIdParamSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
});

/**
 * Approve Post Schema
 * PATCH /v1/content/plan/posts/:postId/approve
 */
export const approvePostSchema = z.object({
  params: z.object({
    postId: z.coerce.number(),
  }),
  body: z.object({
    manual: z.boolean().optional().default(false),
  }),
});

/**
 * Generic Content ID Parameter Schema
 */
export const contentIdParamSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
});

export const planPostIdParamSchema = z.object({
  params: z.object({
    planId: z.coerce.number(),
    postId: z.coerce.number(),
  }),
});
