import { z } from "zod";

/**
 * AI Analytics Query Schema
 * GET /v1/ai-analytics/ai-performance
 */
export const aiAnalyticsQuerySchema = z.object({
  query: z.object({
    days: z.string().regex(/^\d+$/).transform(Number).optional(),
    businessProfileId: z.string().regex(/^\d+$/).transform(Number).optional(),
  }),
});
