import { Router } from "express";
import multer from "multer";
import {
  changeCurrentUserPassword,
  deleteCurrentUserAccount,
  getCurrentUser,
  loginUserController,
  registerUser,
  updateCurrentUser,
  addEmail,
  resendEmailVerification,
  uploadCurrentUserAvatar,
  deleteCurrentUserAvatar,
} from "../user/user.controller";
import {
  authenticateToken,
  logout,
  refreshToken,
} from "@modules/auth/core/auth.middleware";
import { getCsrfToken, validateCsrfToken } from "@middlewares/csrf.middleware";
import { 
  authLimiter, 
  csrfLimiter,
  securityActionLimiter 
} from "@middlewares/rateLimit.middleware";
import { validate } from "@middlewares/validate.middleware";
import { 
  loginSchema, 
  registerSchema, 
  socialAuthSchema,
  forgotPasswordSchema, 
  resetPasswordSchema,
  verifyEmailSchema,
  updateCurrentUserSchema,
  changePasswordSchema,
  addEmailSchema,
  uploadAvatarSchema,
} from "../core/auth.validation";
import * as authController from "./auth.controller";

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

const authRoutes = Router();

authRoutes.post(
  "/register",
  authLimiter,
  validate(registerSchema),
  registerUser
);

authRoutes.post(
  "/login", 
  authLimiter, 
  validate(loginSchema), 
  loginUserController
);

authRoutes.post(
  "/social/google",
  authLimiter,
  validate(socialAuthSchema),
  authController.googleSocialAuth
);

authRoutes.post(
  "/social/facebook",
  authLimiter,
  validate(socialAuthSchema),
  authController.facebookSocialAuth
);

// Identity Lifecycle Routes (Production Grade)
authRoutes.get(
  "/verify-email", 
  validate(verifyEmailSchema), 
  authController.verifyEmail
);

authRoutes.post(
  "/forgot-password", 
  securityActionLimiter, 
  validate(forgotPasswordSchema), 
  authController.forgotPassword
);

authRoutes.post(
  "/reset-password", 
  validate(resetPasswordSchema), 
  authController.resetPassword
);

authRoutes.post(
  "/resend-verification", 
  securityActionLimiter, 
  validate(forgotPasswordSchema), // Reuse forgotPassword schema (just needs email)
  authController.resendVerification
);

// Token management routes
authRoutes.get("/csrf-token", csrfLimiter, getCsrfToken);
authRoutes.post("/refresh", refreshToken);
authRoutes.post("/logout", validateCsrfToken, logout);

authRoutes.get("/me", authenticateToken, getCurrentUser);
authRoutes.put(
  "/me",
  authenticateToken,
  validateCsrfToken,
  validate(updateCurrentUserSchema),
  updateCurrentUser,
);
authRoutes.put(
  "/me/password",
  authenticateToken,
  validateCsrfToken,
  securityActionLimiter,
  validate(changePasswordSchema),
  changeCurrentUserPassword,
);
authRoutes.delete(
  "/me",
  authenticateToken,
  validateCsrfToken,
  securityActionLimiter,
  deleteCurrentUserAccount,
);

// No-email social users: attach an email to their account and trigger verification.
authRoutes.post(
  "/me/email",
  authenticateToken,
  validateCsrfToken,
  securityActionLimiter,
  validate(addEmailSchema),
  addEmail,
);

// Resend the verification email for the current user's pending email.
authRoutes.post(
  "/me/email/resend",
  authenticateToken,
  validateCsrfToken,
  securityActionLimiter,
  resendEmailVerification,
);

// Avatar upload (multipart, single image under "file") + remove.
authRoutes.post(
  "/me/avatar",
  authenticateToken,
  validateCsrfToken,
  securityActionLimiter,
  avatarUpload.single("file"),
  validate(uploadAvatarSchema),
  uploadCurrentUserAvatar,
);
authRoutes.delete(
  "/me/avatar",
  authenticateToken,
  validateCsrfToken,
  securityActionLimiter,
  deleteCurrentUserAvatar,
);

export default authRoutes;








