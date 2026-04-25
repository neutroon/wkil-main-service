import { z } from "zod";

/**
 * Upload Media Asset Schema
 * POST /v1/media
 */
export const uploadMediaSchema = z.object({
  body: z.object({
    businessProfileId: z.string().regex(/^\d+$/, "businessProfileId must be numeric"),
    name: z.string().min(2, "Name must be at least 2 characters"),
    instructions: z.string().min(10, "Instructions must be at least 10 characters"),
  }),
});

/**
 * Update Media Meta Schema
 * PATCH /v1/media/:id
 */
export const updateMediaSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, "ID must be numeric"),
  }),
  body: z.object({
    name: z.string().min(2).optional(),
    instructions: z.string().min(10).optional(),
  }),
});

/**
 * AI Visual Generation Schema
 * POST /v1/media/ai/generate
 */
export const aiGenerateSchema = z.object({
  body: z.object({
    businessProfileId: z.number().int().positive(),
    prompt: z.string().min(5, "Prompt is too short"),
    postId: z.number().int().optional(),
  }),
});

/**
 * AI Visual Refinement Schema
 * POST /v1/media/ai/refine
 */
export const aiRefineSchema = z.object({
  body: z.object({
    businessProfileId: z.number().int().positive(),
    assetId: z.number().int().positive(),
    instruction: z.string().min(5, "Instruction is too short"),
    postId: z.number().int().optional(),
  }),
});

/**
 * Generic Media ID Parameter Schema
 */
export const mediaIdParamSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/, "ID must be numeric"),
  }),
});
