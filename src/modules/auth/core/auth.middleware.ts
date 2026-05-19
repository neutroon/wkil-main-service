import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import prisma from "@config/prisma";
import { AppError } from "@middlewares/errorHandler.middleware";
import { env } from "@config/env";
import { logger } from "@utils/logger";

const { JWT_SECRET, JWT_REFRESH_SECRET } = env;
const ACCESS_TOKEN_EXPIRES_IN = "15m"; // Short-lived — rotated every 14 min via silent refresh
const REFRESH_TOKEN_EXPIRES_IN = "7d";

interface AuthRequest extends Request {
  user?: {
    id: number;
    name: string;
    email: string;
    role: "super_admin" | "admin" | "manager" | "user";
    isEmailVerified: boolean;
  };
}

// Generate access token
export const generateAccessToken = (payload: {
  id: number;
  name: string;
  email: string;
  role: string;
}) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES_IN });
};

// Generate refresh token
export const generateRefreshToken = (payload: {
  id: number;
  name: string;
  email: string;
  role: string;
}) => {
  return jwt.sign(payload, JWT_REFRESH_SECRET, {
    expiresIn: REFRESH_TOKEN_EXPIRES_IN,
  });
};

export const setAuthCookies = (
  res: Response,
  accessToken: string,
  refreshToken: string,
) => {
  const isProduction = env.NODE_ENV === "production";
  const isTunnel = env.BACKEND_URL?.includes("ngrok-free.dev") || false;

  // Production/tunnel: SameSite=None (required for cross-site cookie delivery).
  // Development (http://localhost): SameSite=Lax, Secure=false (browsers block
  // Secure cookies on plain HTTP, which would silently drop all cookies in dev).
  const cookieOptions: any = {
    httpOnly: true,
    secure: isProduction || isTunnel,
    sameSite: isProduction || isTunnel ? "none" : "lax",
    path: "/",
  };

  // Access token cookie (short-lived)
  res.cookie("accessToken", accessToken, {
    ...cookieOptions,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  });

  // Refresh token cookie (long-lived)
  res.cookie("refreshToken", refreshToken, {
    ...cookieOptions,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
};

// export const setUserRoleCookies = (res: Response, role: string, user: any) => {
//   res.cookie("role", role, {
//     httpOnly: false, // frontend & middleware can read
//     secure: false,
//     sameSite: "lax",
//     maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
//     path: "/",
//   });
// };

// export const setAdminAuthCookies = (
//   res: Response,
//   accessToken: string,
//   refreshToken: string
// ) => {
//   const isProduction = process.env.NODE_ENV === "production";

//   res.cookie("adminAccessToken", accessToken, {
//     httpOnly: true,
//     secure: isProduction,
//     sameSite: isProduction ? "strict" : "lax",
//     maxAge: 15 * 60 * 1000, // 15 minutes
//     path: "/",
//   });

//   res.cookie("adminRefreshToken", refreshToken, {
//     httpOnly: true,
//     secure: isProduction,
//     sameSite: isProduction ? "strict" : "lax",
//     maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
//     path: "/",
//   });
// };

// Clear auth cookies
export const clearAuthCookies = (res: Response) => {
  res.clearCookie("accessToken", { path: "/" });
  res.clearCookie("refreshToken", { path: "/" });
  res.clearCookie("csrfToken", { path: "/" });
};

// export const clearAdminAuthCookies = (res: Response) => {
//   res.clearCookie("adminAccessToken", { path: "/" });
//   res.clearCookie("adminRefreshToken", { path: "/" });
// };

// Authenticate using both header and cookie
export const authenticateToken = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    let token: string | undefined;

    // Check Authorization header first
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1];
    }

    // If no header token, check cookies
    if (!token) {
      token = req.cookies?.accessToken;
    }

    if (!token || token === "undefined" || token === "null") {
      throw new AppError("Access token required", 401, true, "NO_TOKEN");
    }

    const decoded = jwt.verify(token, JWT_SECRET) as any;

    // Check if user exists in database and is active
    const user = await prisma.user.findFirst({
      where: {
        id: decoded.id,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isEmailVerified: true,
      },
    });

    if (!user) {
      throw new AppError(
        "Invalid token - user not found or deactivated",
        401,
        true,
        "USER_NOT_FOUND",
      );
    }

    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role as "user" | "admin",
      isEmailVerified: user.isEmailVerified,
    };

    next();
  } catch (error: any) {
    if (error.name === "TokenExpiredError") {
      throw new AppError("Token expired", 401, true, "TOKEN_EXPIRED");
    }
    // Change to 401 for invalid tokens to trigger client-side re-auth
    throw new AppError("Invalid token", 401, true, "INVALID_TOKEN");
  }
};

// Refresh token middleware with Rotation & Grace Period
export const refreshToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    const token = req.cookies?.refreshToken;

    if (!token) {
      throw new AppError(
        "Refresh token required",
        401,
        true,
        "NO_REFRESH_TOKEN",
      );
    }

    const decoded = jwt.verify(token, JWT_REFRESH_SECRET) as any;

    // Check if user exists and verify stored refresh token hash (Rotation + Grace Period)
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        refreshTokenHash: true,
        previousRefreshTokenHash: true,
        rotatedAt: true,
      },
    });

    if (!user || (!user.refreshTokenHash && !user.previousRefreshTokenHash)) {
      throw new AppError(
        "Invalid refresh token",
        401,
        true,
        "INVALID_REFRESH_TOKEN",
      );
    }

    let isGracePeriodMatch = false;
    const isCurrentMatch = user.refreshTokenHash
      ? await bcrypt.compare(token, user.refreshTokenHash)
      : false;

    if (!isCurrentMatch) {
      // Check grace period for parallel requests (e.g. multi-tab sync)
      const isPreviousMatch = user.previousRefreshTokenHash
        ? await bcrypt.compare(token, user.previousRefreshTokenHash)
        : false;
      const wasRecentlyRotated =
        user.rotatedAt &&
        Date.now() - new Date(user.rotatedAt).getTime() < 30000; // 30s grace

      if (isPreviousMatch && wasRecentlyRotated) {
        isGracePeriodMatch = true;
        logger.info("Refresh token grace period hit (multi-tab sync)", {
          userId: user.id,
        });
      } else {
        // SECURITY: Potential token theft/reuse. Revoke everything for safety.
        await prisma.user.update({
          where: { id: decoded.id },
          data: {
            refreshTokenHash: null,
            previousRefreshTokenHash: null,
            refreshTokenExpiresAt: null,
            rotatedAt: null,
          },
        });
        throw new AppError(
          "Session compromised - please login again",
          401,
          true,
          "TOKEN_REUSE_DETECTED",
        );
      }
    }

    // Generate new tokens
    const userData = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    };

    const newAccessToken = generateAccessToken(userData);

    if (isGracePeriodMatch) {
      // Grace period: Just return new access token, don't rotate again
      // (The other parallel request already set the new refresh token cookie)
      res.json({
        message: "Tokens refreshed successfully (grace period)",
        accessToken: newAccessToken,
      });
    } else {
      // Normal rotation
      const newRefreshToken = generateRefreshToken(userData);
      const salt = await bcrypt.genSalt(10);
      const newHash = await bcrypt.hash(newRefreshToken, salt);

      await prisma.user.update({
        where: { id: user.id },
        data: {
          previousRefreshTokenHash: user.refreshTokenHash, // Move current to previous
          refreshTokenHash: newHash,
          refreshTokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          rotatedAt: new Date(),
        },
      });

      setAuthCookies(res, newAccessToken, newRefreshToken);

      res.json({
        message: "Tokens refreshed successfully",
        accessToken: newAccessToken,
      });
    }
  } catch (error: any) {
    // If it's a real error (not just a 401 we throw), clear everything
    if (!(error instanceof AppError && error.code === "TOKEN_REUSE_DETECTED")) {
      res.clearCookie("accessToken", { path: "/" });
      res.clearCookie("refreshToken", { path: "/" });
    }

    if (error.name === "TokenExpiredError") {
      throw new AppError(
        "Refresh token expired",
        401,
        true,
        "REFRESH_TOKEN_EXPIRED",
      );
    }
    throw error instanceof AppError
      ? error
      : new AppError(
          "Invalid refresh token",
          401,
          true,
          "INVALID_REFRESH_TOKEN",
        );
  }
};

// Logout middleware
// Logout middleware
export const logout = async (req: Request, res: Response) => {
  // Invalidate refresh token in DB if possible
  try {
    const authHeader = req.headers.authorization;
    let token: string | undefined;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1];
    } else {
      token = req.cookies?.accessToken;
    }

    if (token) {
      const decoded = jwt.decode(token) as any;
      if (decoded?.id) {
        await prisma.user.update({
          where: { id: decoded.id },
          data: {
            refreshTokenHash: null,
            previousRefreshTokenHash: null,
            refreshTokenExpiresAt: null,
            rotatedAt: null,
          },
        });
      }
    }
  } catch (err) {
    // Silent fail on DB update during logout
  }

  clearAuthCookies(res);
  res.json({ message: "Logged out successfully" });
};

export const requireAdmin = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  if (!req.user || !["super_admin", "admin"].includes(req.user.role)) {
    throw new AppError("Admin access required", 403, true, "ADMIN_REQUIRED");
  }
  next();
};

export const requireSuperAdmin = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  if (!req.user || req.user.role !== "super_admin") {
    throw new AppError(
      "Super admin access required",
      403,
      true,
      "SUPER_ADMIN_REQUIRED",
    );
  }
  next();
};

export const requireManagerOrAdmin = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  if (
    !req.user ||
    !["super_admin", "admin", "manager"].includes(req.user.role)
  ) {
    throw new AppError(
      "Manager or admin access required",
      403,
      true,
      "MANAGER_OR_ADMIN_REQUIRED",
    );
  }
  next();
};

export const requireManagerAccess = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const user = req.user;
    const rawUserId = req.params.userId ?? req.params.id;
    const targetUserId = Number(rawUserId);

    if (!user) {
      return res.status(401).json({
        error: "Authentication required",
        code: "AUTH_REQUIRED",
      });
    }

    // Super admins and admins can manage anyone
    if (["super_admin", "admin"].includes(user.role)) {
      return next();
    }

    // Managers can only manage assigned users
    if (user.role === "manager") {
      const { canManageUser } = await import("../user/user.service");
      const canManage = Number.isFinite(targetUserId)
        ? await canManageUser(user.id, targetUserId)
        : false;

      if (!canManage) {
        throw new AppError(
          "You can only manage users assigned to you",
          403,
          true,
          "INSUFFICIENT_PERMISSIONS",
        );
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

export const requireUser = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  if (!req.user) {
    throw new AppError("Authentication required", 401, true, "AUTH_REQUIRED");
  }
  next();
};

/**
 * Middleware to enforce email verification.
 * Blocks access to protected routes if the user's email is not verified.
 */
export const requireVerified = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  if (!req.user) {
    throw new AppError("Authentication required", 401, true, "AUTH_REQUIRED");
  }

  if (!req.user.isEmailVerified) {
    const error = new AppError(
      "Email verification required",
      403,
      true,
      "EMAIL_NOT_VERIFIED",
    ) as any;
    error.email = req.user.email;
    throw error;
  }
  next();
};
