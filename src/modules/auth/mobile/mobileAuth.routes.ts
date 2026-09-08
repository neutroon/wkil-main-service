import { Router } from "express";
import { authLimiter } from "@middlewares/rateLimit.middleware";
import { validate } from "@middlewares/validate.middleware";
import { loginSchema } from "@modules/auth/core/auth.validation";
import { authenticateToken } from "@modules/auth/core/auth.middleware";
import {
  mobileCurrentUser,
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

// POST /v1/mobile/auth/login
// Body: { email, password } → { user, accessToken, refreshToken, expiresIn }
mobileAuthRoutes.post("/auth/login", authLimiter, validate(loginSchema), mobileLogin);

// POST /v1/mobile/auth/refresh
// Header: `Authorization: Bearer <refreshToken>` (preferred)
// OR body: { refreshToken } → { accessToken, refreshToken?, expiresIn }
mobileAuthRoutes.post("/auth/refresh", authLimiter, mobileRefresh);

// POST /v1/mobile/auth/logout
// Header / body: refresh token → revokes in DB
mobileAuthRoutes.post("/auth/logout", mobileLogout);

// GET /v1/mobile/auth/me
// Header: Authorization: Bearer <accessToken> → { user }
mobileAuthRoutes.get("/auth/me", authenticateToken, mobileCurrentUser);

export default mobileAuthRoutes;
