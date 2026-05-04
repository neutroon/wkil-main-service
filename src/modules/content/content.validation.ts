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
    startDate: z.string().min(1, "startDate is required"),
    endDate: z.string().min(1, "endDate is required"),
    goals: z.string().optional(),
    currentTrends: z.array(z.string()).optional(),
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
