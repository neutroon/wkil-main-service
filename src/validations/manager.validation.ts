import { z } from "zod";

/**
 * User Assignment Schema
 * POST /v1/manager/assign-user
 */
export const userAssignmentSchema = z.object({
  body: z.object({
    managerId: z.number().int().positive("Manager ID must be a positive integer"),
    userId: z.number().int().positive("User ID must be a positive integer"),
  }),
});

/**
 * Analytics Query Schema
 * GET /v1/manager/my-users
 */
export const analyticsQuerySchema = z.object({
  query: z.object({
    days: z.coerce.number().optional(),
    includeInactive: z.string().transform(v => v === "true").optional(),
  }),
});

/**
 * Generic ID Parameter Schema
 */
export const idParamSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
});

/**
 * Device Info Schema
 */
export const deviceInfoSchema = z.object({
  body: z.object({
    deviceInfo: z.object({
      userAgent: z.string().optional(),
      platform: z.string().optional(),
      browser: z.string().optional(),
      device: z.string().optional(),
    }),
  }),
});
