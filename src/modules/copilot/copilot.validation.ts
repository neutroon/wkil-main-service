import { z } from "zod";

export const copilotMessagesQuerySchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

export const copilotPostMessageSchema = z.object({
  body: z.object({
    text: z.string().min(1).max(4000),
  }),
});
