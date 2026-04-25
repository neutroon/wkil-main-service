import { z } from "zod";

/**
 * Dashboard Query Schema
 * GET /v1/dashboard/stats
 * GET /v1/dashboard/activity
 */
export const dashboardQuerySchema = z.object({
  query: z.object({
    days: z.string().regex(/^\d+$/).transform(Number).optional(),
    limit: z.string().regex(/^\d+$/).transform(Number).optional(),
  }),
});
