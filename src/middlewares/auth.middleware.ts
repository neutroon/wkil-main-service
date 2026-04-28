import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import prisma from "../config/prisma";
import { AppError } from "./errorHandler.middleware";
import { env } from "../config/env";

const { JWT_SECRET, JWT_REFRESH_SECRET } = env;
const ACCESS_TOKEN_EXPIRES_IN = "24h"; 
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
  refreshToken: string
) => {
  const isProduction = env.NODE_ENV === "production";
  const isTunnel = env.BACKEND_URL?.includes("ngrok-free.dev") || false;

  // CRITICAL for ngrok: Cross-site cookies require SameSite=None and Secure=true
  const cookieOptions: any = {
    httpOnly: true,
    secure: isProduction || isTunnel,
    sameSite: isTunnel ? "none" : "lax",
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
};

// export const clearAdminAuthCookies = (res: Response) => {
//   res.clearCookie("adminAccessToken", { path: "/" });
//   res.clearCookie("adminRefreshToken", { path: "/" });
// };

// Authenticate using both header and cookie
export const authenticateToken = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
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
      select: { id: true, name: true, email: true, role: true, isEmailVerified: true },
    });

    if (!user) {
      throw new AppError("Invalid token - user not found or deactivated", 401, true, "USER_NOT_FOUND");
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

// Refresh token middleware
export const refreshToken = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const refreshToken = req.cookies?.refreshToken;

    if (!refreshToken) {
      throw new AppError("Refresh token required", 401, true, "NO_REFRESH_TOKEN");
    }

    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as any;

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, name: true, email: true, role: true },
    });

    if (!user) {
      throw new AppError("Invalid refresh token", 401, true, "INVALID_REFRESH_TOKEN");
    }

    // Generate new tokens
    const newAccessToken = generateAccessToken({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    });

    const newRefreshToken = generateRefreshToken({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    });

    // Set new cookies
    setAuthCookies(res, newAccessToken, newRefreshToken);

    res.json({
      message: "Tokens refreshed successfully",
      accessToken: newAccessToken,
    });
  } catch (error: any) {
    if (error.name === "TokenExpiredError") {
      throw new AppError("Refresh token expired", 401, true, "REFRESH_TOKEN_EXPIRED");
    }
    throw new AppError("Invalid refresh token", 401, true, "INVALID_REFRESH_TOKEN");
  }
};

// Logout middleware
export const logout = (req: Request, res: Response) => {
  clearAuthCookies(res);
  res.json({ message: "Logged out successfully" });
};

export const requireAdmin = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.user || !["super_admin", "admin"].includes(req.user.role)) {
    throw new AppError("Admin access required", 403, true, "ADMIN_REQUIRED");
  }
  next();
};

export const requireSuperAdmin = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.user || req.user.role !== "super_admin") {
    throw new AppError("Super admin access required", 403, true, "SUPER_ADMIN_REQUIRED");
  }
  next();
};

export const requireManagerOrAdmin = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  if (
    !req.user ||
    !["super_admin", "admin", "manager"].includes(req.user.role)
  ) {
    throw new AppError("Manager or admin access required", 403, true, "MANAGER_OR_ADMIN_REQUIRED");
  }
  next();
};

export const requireManagerAccess = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const user = req.user;
    const { userId } = req.params;

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
      const { canManageUser } = await import("../services/user.service");
      const canManage = await canManageUser(user.id, parseInt(userId));

      if (!canManage) {
        throw new AppError("You can only manage users assigned to you", 403, true, "INSUFFICIENT_PERMISSIONS");
      }
    }

    next();
  } catch (error) {
    res.status(500).json({
      error: "Authorization check failed",
      code: "AUTH_CHECK_FAILED",
    });
  }
};

export const requireUser = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
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
    const error = new AppError("Email verification required", 403, true, "EMAIL_NOT_VERIFIED") as any;
    error.email = req.user.email;
    throw error;
  }
  next();
};
