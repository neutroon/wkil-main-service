import { z } from "zod";

/**
 * Widget Installation Schema
 * POST /v1/widget/installs
 */
export const widgetInstallSchema = z.object({
  body: z.object({
    businessProfileId: z.number().int().positive("Invalid businessProfileId"),
    allowedOrigins: z.union([z.string(), z.array(z.string())]).optional(),
    label: z.string().max(200).optional(),
  }),
});

/**
 * Update Widget Installation Schema
 * PATCH /v1/widget/installs/:id
 */
export const updateWidgetInstallSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
  body: z.object({
    allowedOrigins: z.union([z.string(), z.array(z.string())]).optional(),
    label: z.string().max(200).optional(),
    isActive: z.boolean().optional(),
  }),
});

/**
 * Widget Conversation Query Schema
 * GET /v1/widget/conversations
 */
export const widgetConversationQuerySchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).optional().default("1"),
    limit: z.string().regex(/^\d+$/).optional().default("20"),
    status: z.string().optional(),
  }),
});

/**
 * Approve AI Draft Schema
 * PUT /v1/widget/conversations/:id/messages/:mid/approve
 */
export const approveDraftSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
    mid: z.coerce.number(),
  }),
  body: z.object({
    editedContent: z.string().optional(),
  }),
});

/**
 * Send Widget Reply Schema
 * POST /v1/widget/conversations/:id/messages
 */
export const widgetReplySchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
  body: z.object({
    text: z.string().min(1, "text is required").max(4000),
  }),
});

/**
 * Generic Widget ID Schema
 */
export const widgetIdParamSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
});
