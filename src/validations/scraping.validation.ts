import { z } from "zod";

/**
 * Website Analysis Schema
 * POST /v1/scraping/analyze-website
 */
export const websiteAnalysisSchema = z.object({
  body: z.object({
    url: z.string().url("الرابط غير صالح").min(1, "الرابط مطلوب لبدء التحليل"),
  }),
});
