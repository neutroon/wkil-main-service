import { z } from "zod";

/**
 * Admin/Manager Creation Schema
 */
export const createAdminManagerSchema = z.object({
  body: z.object({
    name: z.string().min(2, "Name must be at least 2 characters"),
    email: z.string().email("Invalid email address"),
    password: z.string().min(8, "Password must be at least 8 characters"),
  }),
});

/**
 * Billing Settings Update Schema
 */
export const updateBillingSettingsSchema = z.object({
  body: z.object({
    billing_multiplier: z.coerce.number(),
  }),
});

/**
 * Business Usage Update Schema
 */
export const updateBusinessUsageSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
  body: z.object({
    tokensUsed: z.coerce.number(),
  }),
});

/**
 * Generic Admin ID Schema
 */
export const adminBusinessIdParamSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
});
