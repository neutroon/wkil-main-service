import { Router } from "express";
import { authLimiter } from "@middlewares/rateLimit.middleware";
import { validate } from "@middlewares/validate.middleware";
import { loginSchema } from "@modules/auth/core/auth.validation";
import {
  mobileLogin,
  mobileLogout,
  mobileRefresh,
} from "./mobileAuth.controller";

/**
 * Mobile-friendly auth endpoints.
 *
 * Mounted at `/v1/mobile/auth` BEFORE the `authenticateToken` wall in
 * `app.ts`, so these routes are public. They return JWTs in the JSON
 * body instead of setting HttpOnly cookies, which is the standard pattern
 * for native mobile clients (no cookie jar, no CSRF).
 */
const mobileAuthRoutes = Router();

// POST /v1/mobile/auth/login
// Body: { email, password } → { user, accessToken, refreshToken, expiresIn }
mobileAuthRoutes.post("/login", authLimiter, validate(loginSchema), mobileLogin);

// POST /v1/mobile/auth/refresh
// Header: `Authorization: Bearer <refreshToken>` (preferred)
// OR body: { refreshToken } → { accessToken, refreshToken?, expiresIn }
mobileAuthRoutes.post("/refresh", authLimiter, mobileRefresh);

// POST /v1/mobile/auth/logout
// Header / body: refresh token → revokes in DB
mobileAuthRoutes.post("/logout", mobileLogout);

export default mobileAuthRoutes;
