import { z } from "zod";

/**
 * Meta Media Proxy Schema
 * GET /v1/meta/media/:conversationId/:mediaId
 */
export const metaMediaSchema = z.object({
  params: z.object({
    conversationId: z.string().regex(/^\d+$/, "conversationId must be numeric"),
    mediaId: z.string().min(1, "mediaId is required"),
  }),
  query: z.object({
    token: z.string().optional(),
  }),
});
