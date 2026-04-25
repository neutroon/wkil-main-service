import { Router } from "express";
import {
  getCurrentUser,
  loginUserController,
  registerUser,
} from "../controllers/user.controller";
import {
  authenticateToken,
  logout,
  refreshToken,
} from "../middlewares/auth.middleware";
import { authLimiter, securityActionLimiter } from "../middlewares/rateLimit.middleware";
import { validate } from "../middlewares/validate.middleware";
import { 
  loginSchema, 
  registerSchema, 
  forgotPasswordSchema, 
  resetPasswordSchema,
  verifyEmailSchema
} from "../validations/auth.validation";
import * as authController from "../controllers/auth.controller";

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
authRoutes.post("/refresh", refreshToken);
authRoutes.post("/logout", logout);

authRoutes.get("/me", authenticateToken, getCurrentUser);

export default authRoutes;
