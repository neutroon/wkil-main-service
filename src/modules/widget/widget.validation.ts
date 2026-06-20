import { z } from "zod";

const VISITOR_ID_MAX = 128;
const MESSAGE_MAX = 4000;

/**
 * Public Widget Chat Schema
 * POST /v1/public/widget/chat
 */
export const widgetChatSchema = z.object({
  body: z.object({
    visitorId: z.string()
      .min(8, "visitorId must be at least 8 characters")
      .max(VISITOR_ID_MAX, `visitorId exceeds maximum length of ${VISITOR_ID_MAX}`),
    message: z.string()
      .min(1, "message is required")
      .max(MESSAGE_MAX, `message exceeds maximum length of ${MESSAGE_MAX}`),
    conversationId: z.number().nullable().optional(),
    stream: z.boolean().optional(),
    user: z.object({
      id: z.string().min(1).max(128),
      hash: z.string().min(16).max(256),
      name: z.string().max(256).optional(),
      email: z.string().max(256).optional(),
      phone: z.string().max(64).optional(),
      avatar: z.string().max(1024).optional(),
    }).optional(),
  }),
});

export const widgetMediaChatSchema = z.object({
  body: z.object({
    visitorId: z.string()
      .min(8, "visitorId must be at least 8 characters")
      .max(VISITOR_ID_MAX, `visitorId exceeds maximum length of ${VISITOR_ID_MAX}`),
    message: z.string()
      .max(MESSAGE_MAX, `message exceeds maximum length of ${MESSAGE_MAX}`)
      .optional()
      .default(""),
    conversationId: z.coerce.number().nullable().optional(),
  }),
});

/**
 * Public Widget History Schema
 * GET /v1/public/widget/chat/history
 */
export const widgetHistorySchema = z.object({
  query: z.object({
    visitorId: z.string().min(1, "visitorId is required"),
    conversationId: z.coerce.number().optional(),
  }),
});
