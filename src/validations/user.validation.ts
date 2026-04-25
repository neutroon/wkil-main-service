import { z } from "zod";

/**
 * User Registration Schema
 */
export const registerUserSchema = z.object({
  body: z.object({
    name: z.string().min(2, "Name must be at least 2 characters"),
    email: z.string().email("Invalid email address"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    role: z.enum(["user", "manager", "admin"]).optional().default("user"),
  }),
});

/**
 * User Login Schema
 */
export const loginUserSchema = z.object({
  body: z.object({
    email: z.string().email("Invalid email address"),
    password: z.string().min(1, "Password is required"),
  }),
});

/**
 * User Update Schema (Admin only)
 */
export const updateUserSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/).transform(Number),
  }),
  body: z.object({
    name: z.string().min(2).optional(),
    email: z.string().email().optional(),
    role: z.enum(["user", "manager", "admin"]).optional(),
    plan: z.string().optional(),
    monthlyQuota: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).optional(),
  }),
});

/**
 * Generic User ID Schema
 */
export const userIdParamSchema = z.object({
  params: z.object({
    id: z.string().regex(/^\d+$/).transform(Number),
  }),
});

/**
 * User List Query Schema
 */
export const userListQuerySchema = z.object({
  query: z.object({
    includeInactive: z.string().optional().transform((val) => val === "true"),
  }),
});
