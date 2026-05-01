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
