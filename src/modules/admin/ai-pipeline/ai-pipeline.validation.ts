import { z } from "zod";

/**
 * AI Pipeline validation schemas. Shape matches the global `validate`
 * middleware ({ body, params }).
 */
const modelIdRegex = /^[a-zA-Z0-9._\-/]+$/;

const pipelineKeyParam = z.object({
  params: z.object({
    key: z
      .string()
      .min(2)
      .max(60)
      .regex(/^[a-z0-9_]+$/, "pipeline key must be lowercase snake_case"),
  }),
});

const pipelineBody = z.object({
  displayName: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(280).nullable().optional(),
  modelIds: z
    .array(z.string().trim().min(2).max(120).regex(modelIdRegex))
    .max(20)
    .optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  maxOutputTokens: z.number().int().positive().max(1_000_000).nullable().optional(),
  timeoutMs: z.number().int().positive().max(300_000).nullable().optional(),
  inheritsChatDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const updatePipelineSchema = z.object({
  ...pipelineKeyParam.shape,
  body: pipelineBody,
});

export const pipelineKeySchema = pipelineKeyParam;
