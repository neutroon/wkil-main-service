import { z } from "zod";

export const copilotMessagesQuerySchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    conversationId: z.coerce.number().int().positive().optional(),
  }),
});

export const copilotPostMessageSchema = z.object({
  body: z.object({
    text: z.string().min(1).max(4000),
    // Optional; the frontend posts to a specific thread it has already
    // resolved. When omitted, the service falls back to the user's
    // most-recent conversation (legacy single-thread flow).
    conversationId: z.coerce.number().int().positive().optional(),
  }),
});
