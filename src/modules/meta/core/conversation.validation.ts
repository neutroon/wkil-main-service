import { z } from "zod";

/**
 * Schema for updating conversation AI toggle
 * PATCH /v1/meta/conversations/:id/ai-toggle
 */
export const toggleAiSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
  body: z.object({
    enabled: z.boolean({
      error: "enabled (boolean) is required",
    }),
  }),
});

/**
 * Schema for updating conversation status
 * PATCH /v1/meta/conversations/:id/status
 */
export const updateStatusSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
  body: z.object({
    status: z.enum(["OPEN", "RESOLVED", "ARCHIVED"], {
      error: "Status must be OPEN, RESOLVED, or ARCHIVED",
    }),
  }),
});

/**
 * Schema for sending a manual message
 * POST /v1/meta/conversations/:id/messages
 */
export const sendMessageSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
  body: z.object({
    message: z.string().min(1, "Message cannot be empty").max(2000, "Message too long"),
  }),
});
