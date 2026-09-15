import { Request, Response } from "express";
import {
  AppError,
  extractRefreshToken,
  getMobileUserShape,
  issueAuthSession,
  validateAndRotateRefreshToken,
  logoutAndRevoke,
  verifyCredentials,
} from "@modules/auth/core/auth.service";
import { getUserById } from "@modules/auth/user/user.service";
import {
  authenticateSocialUser,
  verifyGoogleIdToken,
} from "@modules/auth/core/socialAuth.service";
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
    user: getMobileUserShape(user),
    ...tokens,
  });
};

export const mobileGoogle = async (req: Request, res: Response) => {
  const { token } = req.body as { token: string };
  const profile = await verifyGoogleIdToken(token);
  const socialUser = await authenticateSocialUser("google", profile);
  const user = await getUserById(socialUser.id);
  if (!user) throw new AppError("User not found", 404);
  const tokens = await issueAuthSession({
    id: socialUser.id,
    name: socialUser.name,
    email: socialUser.email,
    role: socialUser.role,
    isSocialUser: socialUser.isSocialUser,
  });

  logger.info("mobile.auth.google", { userId: socialUser.id });
  res.status(200).json({
    message: "Social authentication successful",
    user: getMobileUserShape(user),
    ...tokens,
  });
};

/**
 * GET /v1/mobile/auth/me
 * Header: Authorization: Bearer <accessToken>
 * Returns the current profile fields needed by the native account surface.
 */
export const mobileCurrentUser = async (req: Request, res: Response) => {
  const userId = Number((req as any).user?.id);
  const user = await getUserById(userId);
  if (!user) throw new AppError("User not found", 404);
  res.json({ user: getMobileUserShape(user) });
};

/**
 * POST /v1/mobile/auth/refresh
 * Body: { refreshToken } OR header: `Authorization: Bearer <refreshToken>`.
 * Preserve existing body/cookie precedence when multiple sources are supplied.
 * Returns: { accessToken, refreshToken?, expiresIn }
 */
export const mobileRefresh = async (req: Request, res: Response) => {
  acceptMobileRefreshBearer(req);
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
  acceptMobileRefreshBearer(req);
  await logoutAndRevoke(req, res);
  res.json({ message: "Logged out successfully" });
};

// The shared extractor is also used by web auth. Bridge bearer transport only
// for mobile, after its existing body/cookie sources have been considered.
const acceptMobileRefreshBearer = (req: Request) => {
  if (extractRefreshToken(req)) return;
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization?.trim() ?? "");
  if (bearer) req.body = { ...req.body, refreshToken: bearer[1] };
};
