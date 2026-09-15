import { Router, type ErrorRequestHandler } from "express";
import { AppError } from "@middlewares/errorHandler.middleware";
import { logger } from "@utils/logger";
import { authLimiter } from "@middlewares/rateLimit.middleware";
import { validate } from "@middlewares/validate.middleware";
import {
  loginSchema,
  socialAuthSchema,
} from "@modules/auth/core/auth.validation";
import { authenticateToken } from "@modules/auth/core/auth.middleware";
import {
  mobileCurrentUser,
  mobileGoogle,
  mobileLogin,
  mobileLogout,
  mobileRefresh,
} from "./mobileAuth.controller";

/**
 * Mobile-friendly auth endpoints.
 *
 * Mounted at `/v1/mobile/auth` BEFORE the `authenticateToken` wall in
 * `app.ts`. Login, refresh, and logout are public; the profile endpoint
 * applies route-level token authentication. Tokens are returned in the JSON
 * body instead of setting HttpOnly cookies for native mobile clients.
 */
const mobileAuthRoutes = Router();

// Limit this response boundary to Google auth. Never serialize arbitrary error
// properties or pass unexpected provider/database details to the global handler.
const mobileGoogleErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof AppError && error.isOperational) {
    res.status(error.statusCode).json({ status: "error", message: error.message, code: error.code });
    return;
  }
  logger.error("mobile.auth.google.failed");
  res.status(500).json({
    status: "error",
    message: "Unable to complete Google authentication",
    code: "GOOGLE_AUTH_FAILED",
  });
};

// POST /v1/mobile/auth/login
// Body: { email, password } → { user, accessToken, refreshToken, expiresIn }
mobileAuthRoutes.post("/auth/login", authLimiter, validate(loginSchema), mobileLogin);

mobileAuthRoutes.post(
  "/auth/google",
  authLimiter,
  validate(socialAuthSchema),
  async (req, res, next) => {
    try {
      await mobileGoogle(req, res);
    } catch (error) {
      mobileGoogleErrorHandler(error, req, res, next);
    }
  },
);

// POST /v1/mobile/auth/refresh
// Header: `Authorization: Bearer <refreshToken>`
// OR body: { refreshToken } → { accessToken, refreshToken?, expiresIn }
mobileAuthRoutes.post("/auth/refresh", authLimiter, mobileRefresh);

// POST /v1/mobile/auth/logout
// Header / body: refresh token → revokes in DB
mobileAuthRoutes.post("/auth/logout", mobileLogout);

// GET /v1/mobile/auth/me
// Header: Authorization: Bearer <accessToken> → { user }
mobileAuthRoutes.get("/auth/me", authenticateToken, mobileCurrentUser);

export default mobileAuthRoutes;
