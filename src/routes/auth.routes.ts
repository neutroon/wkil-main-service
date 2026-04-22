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
import {
  validateUserLogin,
  validateUserRegistration,
} from "../middlewares/validation.middleware";
import * as authController from "../controllers/auth.controller";

const authRoutes = Router();

authRoutes.post(
  "/register",
  authLimiter,
  validateUserRegistration,
  registerUser
);
authRoutes.post("/login", authLimiter, validateUserLogin, loginUserController);

// Identity Lifecycle Routes (Production Grade)
authRoutes.get("/verify-email", authController.verifyEmail);
authRoutes.post("/forgot-password", securityActionLimiter, authController.forgotPassword);
authRoutes.post("/reset-password", authController.resetPassword);
authRoutes.post("/resend-verification", securityActionLimiter, authController.resendVerification);

// Token management routes
authRoutes.post("/refresh", refreshToken);
authRoutes.post("/logout", logout);

authRoutes.get("/me", authenticateToken, getCurrentUser);

export default authRoutes;
