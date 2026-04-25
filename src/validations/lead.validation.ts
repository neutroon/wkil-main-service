import { z } from "zod";

/**
 * Lead Creation Schema
 * POST /v1/leads
 */
export const leadSchema = z.object({
  body: z.object({
    name: z.string().min(2, "Name must be at least 2 characters").max(100),
    email: z.string().email("Invalid email address"),
    url: z.string().url("Invalid URL").optional().or(z.literal("")),
    message: z.string().max(1000, "Message is too long").optional().or(z.literal("")),
  }),
});
