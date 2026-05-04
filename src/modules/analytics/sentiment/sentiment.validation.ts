import { z } from "zod";

/**
 * Sentiment Analysis Schema
 * POST /v1/sentiment
 */
export const sentimentSchema = z.object({
  body: z.object({
    text: z.string().min(1, "Text is required").max(5000, "Text is too long for analysis"),
  }),
});
