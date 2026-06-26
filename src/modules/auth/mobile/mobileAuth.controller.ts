import { Request, Response } from "express";
import {
  AppError,
  issueAuthSession,
  validateAndRotateRefreshToken,
  logoutAndRevoke,
  publicUserShape,
  verifyCredentials,
} from "@modules/auth/core/auth.service";
import { logger } from "@utils/logger";

/**
 * POST /v1/mobile/auth/login
 * Body: { email, password }
 * Returns: { user, accessToken, refreshToken, expiresIn }
 */
export const mobileLogin = async (req: Request, res: Response) => {
  const { email, password } = req.body as { email?: string; password?: string };
  const user = await verifyCredentials(email ?? "", password ?? "");
  if (!user) {
    throw new AppError(
      "Invalid email or password",
      401,
      true,
      "INVALID_CREDENTIALS",
    );
  }

  const tokens = await issueAuthSession({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isSocialUser: user.isSocialUser,
  });

  logger.info("mobile.auth.login", { userId: user.id });
  res.status(200).json({
    message: "Login successful",
    user: publicUserShape(user),
    ...tokens,
  });
};

/**
 * POST /v1/mobile/auth/refresh
 * Header: `Authorization: Bearer <refreshToken>` (preferred) OR
 * Body: { refreshToken }
 * Returns: { accessToken, refreshToken?, expiresIn }
 */
export const mobileRefresh = async (req: Request, res: Response) => {
  const result = await validateAndRotateRefreshToken(req);
  res.json({
    message: result.isGracePeriod
      ? "Tokens refreshed successfully (grace period)"
      : "Tokens refreshed successfully",
    accessToken: result.tokens.accessToken,
    // During the grace period, the refresh token was NOT rotated — the
    // client should keep using the one it already has. We omit it from
    // the response in that case so the client doesn't accidentally
    // overwrite its current refresh token with the same value.
    refreshToken: result.isGracePeriod ? undefined : result.tokens.refreshToken,
    expiresIn: result.tokens.expiresIn,
  });
};

/**
 * POST /v1/mobile/auth/logout
 * Header / body: refresh token → revokes in DB. Idempotent.
 */
export const mobileLogout = async (req: Request, res: Response) => {
  await logoutAndRevoke(req, res);
  res.json({ message: "Logged out successfully" });
};
