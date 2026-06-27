import bcrypt from "bcrypt";
import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import prisma from "@config/prisma";
import { env } from "@config/env";
import { hashToken, generateRandomToken } from "@modules/auth/core/tokenCrypto";
import { sendVerificationEmail, sendPasswordResetEmail } from "@modules/mail/mail.service";
import { logger } from "@utils/logger";
import { AppError } from "@middlewares/errorHandler.middleware";
import {
  generateAccessToken,
  generateRefreshToken,
  setAuthCookies,
  clearAuthCookies,
} from "@modules/auth/core/auth.middleware";

// Re-exported for callers that import only from auth.service.
export { AppError };

// ── Token TTLs ────────────────────────────────────────────────────────
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const REFRESH_TOKEN_GRACE_MS = 30_000;

// ── Public types ──────────────────────────────────────────────────────
export interface TokenIssuer {
  id: number;
  name: string;
  email: string | null;
  role: string;
  isSocialUser: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface RefreshResult {
  tokens: AuthTokens;
  /** True if the incoming token matched the previous hash inside the grace
   *  window — the refresh token itself was NOT rotated. */
  isGracePeriod: boolean;
}

const PASSWORD_RESET_RESPONSE = {
  message: "If an account exists with that email, a reset link has been sent.",
};

// ════════════════════════════════════════════════════════════════════
//  TOKEN ISSUANCE & ROTATION
// ════════════════════════════════════════════════════════════════════

/**
 * Persist the bcrypt hash of a new refresh token, optionally moving the
 * current hash to `previousRefreshTokenHash` for the 30s grace window.
 */
const persistRefreshHash = async (
  userId: number,
  newRefreshToken: string,
  previousHash: string | null,
) => {
  const salt = await bcrypt.genSalt(10);
  const newHash = await bcrypt.hash(newRefreshToken, salt);
  await prisma.user.update({
    where: { id: userId },
    data: {
      previousRefreshTokenHash: previousHash,
      refreshTokenHash: newHash,
      refreshTokenExpiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      rotatedAt: new Date(),
    },
  });
};

/**
 * Generate a fresh access + refresh pair for [user] and persist the new
 * refresh hash. The previous hash (if any) is cleared — this is an
 * "initial" issue, not a rotation.
 *
 * If [setCookies] is true, the tokens are also written as HttpOnly
 * cookies on the response (web path). The tokens are always returned
 * in the response body so the caller decides what to do with them.
 */
export const issueAuthSession = async (
  user: TokenIssuer,
  options: { setCookies?: Response } = {},
): Promise<AuthTokens> => {
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);
  await persistRefreshHash(user.id, refreshToken, null);

  if (options.setCookies) {
    setAuthCookies(options.setCookies, accessToken, refreshToken);
  }
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
};

/**
 * Pull a refresh token from the request — body first (mobile pattern),
 * then the `refreshToken` cookie (web pattern). Returns null if absent.
 */
export const extractRefreshToken = (req: Request): string | null => {
  const body = req.body as { refreshToken?: string } | undefined;
  if (body?.refreshToken && typeof body.refreshToken === "string") {
    const t = body.refreshToken.trim();
    if (t) return t;
  }
  const cookieToken = (req as Request & { cookies?: Record<string, string> })
    .cookies?.refreshToken;
  if (cookieToken) return cookieToken;
  return null;
};

/**
 * Verify a refresh token's signature, validate it against the stored
 * bcrypt hash (current OR previous within the 30s grace window), rotate
 * the stored hash, and return a new pair. Detects token reuse and
 * revokes the whole session if reuse happens outside the grace window.
 *
 * Throws `AppError` on any failure.
 */
export const validateAndRotateRefreshToken = async (
  req: Request,
): Promise<RefreshResult> => {
  const rawToken = extractRefreshToken(req);
  if (!rawToken) {
    throw new AppError("Refresh token required", 401, true, "NO_REFRESH_TOKEN");
  }

  let decoded: { id: number };
  try {
    decoded = jwt.verify(rawToken, env.JWT_REFRESH_SECRET) as { id: number };
  } catch (err: any) {
    if (err?.name === "TokenExpiredError") {
      throw new AppError("Refresh token expired", 401, true, "REFRESH_TOKEN_EXPIRED");
    }
    throw new AppError("Invalid refresh token", 401, true, "INVALID_REFRESH_TOKEN");
  }

  const user = await prisma.user.findUnique({
    where: { id: decoded.id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isSocialUser: true,
      isActive: true,
      refreshTokenHash: true,
      previousRefreshTokenHash: true,
      rotatedAt: true,
    },
  });

  if (!user || !user.isActive || !user.refreshTokenHash) {
    throw new AppError("Invalid refresh token", 401, true, "INVALID_REFRESH_TOKEN");
  }

  const issuer: TokenIssuer = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isSocialUser: user.isSocialUser,
  };

  const isCurrentMatch = await bcrypt.compare(rawToken, user.refreshTokenHash);

  // Grace period: a parallel request may have already rotated.
  if (!isCurrentMatch) {
    const isPreviousMatch = user.previousRefreshTokenHash
      ? await bcrypt.compare(rawToken, user.previousRefreshTokenHash)
      : false;
    const wasRecentlyRotated =
      user.rotatedAt != null &&
      Date.now() - new Date(user.rotatedAt).getTime() < REFRESH_TOKEN_GRACE_MS;

    if (isPreviousMatch && wasRecentlyRotated) {
      logger.info("auth.refresh.grace_period", { userId: user.id });
      const accessToken = generateAccessToken(issuer);
      return {
        isGracePeriod: true,
        tokens: { accessToken, refreshToken: rawToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS },
      };
    }

    // Reuse outside the grace window — treat as theft, revoke everything.
    logger.warn("auth.refresh.reuse_detected", { userId: user.id });
    await revokeRefreshSession(user.id);
    throw new AppError(
      "Session compromised — please log in again",
      401,
      true,
      "TOKEN_REUSE_DETECTED",
    );
  }

  // Normal rotation.
  const accessToken = generateAccessToken(issuer);
  const newRefreshToken = generateRefreshToken(issuer);
  await persistRefreshHash(user.id, newRefreshToken, user.refreshTokenHash);
  return {
    isGracePeriod: false,
    tokens: { accessToken, refreshToken: newRefreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS },
  };
};

/**
 * Wipe the user's refresh-token hash chain. Used by logout, by reuse
 * detection, and by failed-session bootstrap.
 */
export const revokeRefreshSession = async (userId: number) => {
  await prisma.user.update({
    where: { id: userId },
    data: {
      refreshTokenHash: null,
      previousRefreshTokenHash: null,
      refreshTokenExpiresAt: null,
      rotatedAt: null,
    },
  });
};

/**
 * Best-effort logout. Tries to identify the user from the refresh token
 * (body or cookie) and revoke the session, then clears the auth
 * cookies on the response. Always succeeds; never throws.
 */
export const logoutAndRevoke = async (req: Request, res: Response) => {
  try {
    const raw = extractRefreshToken(req);
    if (raw) {
      const decoded = jwt.decode(raw) as { id?: number } | null;
      if (decoded?.id && Number.isInteger(decoded.id)) {
        await revokeRefreshSession(decoded.id);
        logger.info("auth.logout", { userId: decoded.id });
      }
    }
  } catch (err) {
    logger.warn("auth.logout.revocation_failed", { err: String(err) });
  }
  clearAuthCookies(res);
};

// ════════════════════════════════════════════════════════════════════
//  CREDENTIAL CHECK
// ════════════════════════════════════════════════════════════════════

export interface LoginUser {
  id: number;
  name: string;
  email: string | null;
  role: string;
  avatar: string | null;
  isEmailVerified: boolean;
  isSocialUser: boolean;
  isBusinessProfileCreated: boolean;
  lastVerificationSentAt: Date | null;
}

/**
 * Verify email + password and return the user record. Always checks
 * `isActive: true` so a deactivated account can never produce a session.
 *
 * Returns null when credentials don't match — the caller is responsible
 * for the public-facing error message (and should use a single
 * enumeration-safe message).
 */
export const verifyCredentials = async (
  email: string,
  password: string,
): Promise<LoginUser | null> => {
  const normalizedEmail = email.toLowerCase();
  const user = await prisma.user.findFirst({
    where: { email: normalizedEmail, isActive: true },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      password: true,
      avatar: true,
      isEmailVerified: true,
      isSocialUser: true,
      isBusinessProfileCreated: true,
      lastVerificationSentAt: true,
    },
  });
  if (!user) return null;
  if (!(await bcrypt.compare(password, user.password))) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    avatar: user.avatar,
    isEmailVerified: user.isEmailVerified,
    isSocialUser: user.isSocialUser,
    isBusinessProfileCreated: user.isBusinessProfileCreated,
    lastVerificationSentAt: user.lastVerificationSentAt,
  };
};

/**
 * Public projection of a login result — used by both web and mobile.
 */
export const publicUserShape = (u: LoginUser) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  avatar: u.avatar ?? null,
  isEmailVerified: u.isEmailVerified,
  isSocialUser: u.isSocialUser,
  isBusinessProfileCreated: u.isBusinessProfileCreated,
  lastVerificationSentAt: u.lastVerificationSentAt,
});

// ════════════════════════════════════════════════════════════════════
//  IDENTITY LIFECYCLE
// ════════════════════════════════════════════════════════════════════

export const verifyEmail = async (token: string) => {
  const hashedToken = hashToken(token);
  logger.info("email_verification.start", { hashedToken });

  const user = await prisma.user.findFirst({
    where: { emailVerificationToken: hashedToken, isActive: true },
  });

  if (!user) {
    logger.warn("email_verification.failed", { hashedToken });
    throw new AppError("Invalid or expired verification token", 400);
  }

  return prisma.user.update({
    where: { id: user.id },
    data: { isEmailVerified: true, emailVerificationToken: null },
    select: { id: true, email: true, isEmailVerified: true, updatedAt: true },
  });
};

export const forgotPassword = async (email: string) => {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail, isActive: true },
  });

  if (!user) {
    logger.warn("forgot_password.unknown_email", { email: normalizedEmail });
    return PASSWORD_RESET_RESPONSE;
  }

  const resetToken = generateRandomToken();
  const hashedToken = hashToken(resetToken);
  const expires = new Date(Date.now() + 60 * 60 * 1000);

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordResetToken: hashedToken, passwordResetExpires: expires },
  });

  try {
    if (user.email) {
      await sendPasswordResetEmail(user.email, user.name, resetToken);
    }
  } catch (error) {
    logger.warn("forgot_password.email_dispatch_failed", {
      userId: user.id,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return PASSWORD_RESET_RESPONSE;
};

export const resetPassword = async (token: string, newPassword: string) => {
  const hashedToken = hashToken(token);
  const user = await prisma.user.findFirst({
    where: {
      passwordResetToken: hashedToken,
      passwordResetExpires: { gte: new Date() },
      isActive: true,
    },
  });
  if (!user) {
    throw new AppError("Invalid or expired password reset token", 400);
  }
  const hashedPassword = await bcrypt.hash(newPassword, 10);
  return prisma.user.update({
    where: { id: user.id },
    data: {
      password: hashedPassword,
      passwordResetToken: null,
      passwordResetExpires: null,
    },
    select: { id: true, email: true },
  });
};

export const resendVerification = async (email: string) => {
  const user = await prisma.user.findUnique({
    where: { email, isActive: true },
  });
  if (!user || user.isEmailVerified) {
    return { message: "If the account is unverified, a new link has been sent." };
  }

  const now = new Date();
  const cooldownMs = 60_000;
  if (
    user.lastVerificationSentAt &&
    now.getTime() - user.lastVerificationSentAt.getTime() < cooldownMs
  ) {
    const remaining = Math.ceil(
      (cooldownMs - (now.getTime() - user.lastVerificationSentAt.getTime())) / 1000,
    );
    throw new AppError(`Please wait ${remaining} seconds before requesting another email.`, 429);
  }

  const verificationToken = generateRandomToken();
  const hashedToken = hashToken(verificationToken);
  await prisma.user.update({
    where: { id: user.id },
    data: { emailVerificationToken: hashedToken, lastVerificationSentAt: now },
  });

  if (user.email) {
    await sendVerificationEmail(user.email, user.name, verificationToken);
  }
  return { message: "If the account is unverified, a new link has been sent." };
};
