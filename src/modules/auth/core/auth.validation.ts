import { z } from "zod";

/**
 * User Registration Schema
 */
export const registerSchema = z.object({
  body: z.object({
    email: z.string().email("Invalid email format"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    name: z.string().min(1, "Name is required"),
  }),
});

/**
 * User Login Schema
 */
export const loginSchema = z.object({
  body: z.object({
    email: z.string().email("Invalid email format"),
    password: z.string().min(1, "Password is required"),
  }),
});

export const socialAuthSchema = z.object({
  body: z.object({
    token: z.string().min(1, "Social auth token is required"),
  }),
});

/**
 * Forgot Password Schema
 */
export const forgotPasswordSchema = z.object({
  body: z.object({
    email: z.string().email("Invalid email format"),
  }),
});

/**
 * Reset Password Schema
 */
export const resetPasswordSchema = z.object({
  body: z.object({
    token: z.string().min(1, "Token is required"),
    newPassword: z.string().min(8, "Password must be at least 8 characters"),
  }),
});

/**
 * Email Verification Schema
 */
export const verifyEmailSchema = z.object({
  query: z.object({
    token: z.string().min(1, "Token is required"),
  }),
});

/**
 * Current User Profile Update Schema
 */
export const updateCurrentUserSchema = z.object({
  body: z.object({
    name: z.string().min(2, "Name must be at least 2 characters").optional(),
    email: z.string().email("Invalid email format").optional(),
    avatar: z.string().url("Avatar must be a valid URL").optional().or(z.literal("")),
  }),
});

/**
 * Authenticated Password Change Schema
 */
export const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z.string().min(8, "Password must be at least 8 characters"),
  }),
});

/**
 * Add Initial Email (for no-email social users)
 */
export const addEmailSchema = z.object({
  body: z.object({
    email: z.string().email("Invalid email format"),
  }),
});
