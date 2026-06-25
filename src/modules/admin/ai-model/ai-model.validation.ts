import { z } from "zod";

/**
 * AI Model validation schemas.
 * Shape matches the global `validate` middleware ({ body, params }).
 */

const modelIdRegex = /^[a-zA-Z0-9._\-/]+$/;

const aiModelBody = z.object({
  modelId: z
    .string()
    .trim()
    .min(2, "modelId must be at least 2 characters")
    .max(120, "modelId is too long")
    .regex(modelIdRegex, "modelId contains invalid characters"),
  displayName: z
    .string()
    .trim()
    .min(2, "Display name must be at least 2 characters")
    .max(80, "Display name is too long"),
  provider: z.enum(["google", "openai", "anthropic"]).default("google"),
  category: z.enum(["chat", "embedding", "image", "multimodal"]).default("chat"),
  tierOrder: z.number().int().min(0).max(9999).default(0),
  isActive: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  inputPrice: z.number().nonnegative().nullable().optional(),
  outputPrice: z.number().nonnegative().nullable().optional(),
  maxOutputTokens: z.number().int().positive().max(1_000_000).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const createAiModelSchema = z.object({
  body: aiModelBody,
});

export const updateAiModelSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
  body: aiModelBody.partial(),
});

export const aiModelIdParamSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
});

export const aiModelListQuerySchema = z.object({
  query: z.object({
    category: z
      .enum(["chat", "embedding", "image", "multimodal"])
      .optional(),
    provider: z.enum(["google", "openai", "anthropic"]).optional(),
    isActive: z.enum(["true", "false"]).optional(),
  }),
});
