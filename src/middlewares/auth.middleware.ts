import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import prisma from "../config/prisma";

const JWT_SECRET = process.env.JWT_SECRET || "supersecret";
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "refreshsecret";
const ACCESS_TOKEN_EXPIRES_IN = "24h"; // Production stability lifespan
const REFRESH_TOKEN_EXPIRES_IN = "7d"; // Long-lived refresh token

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

// Set HTTP-only cookies
export const setAuthCookies = (
  res: Response,
  accessToken: string,
  refreshToken: string
) => {
  const isProduction = process.env.NODE_ENV === "production";

  // Access token cookie (short-lived)
  res.cookie("accessToken", accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "strict" : "lax",
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    path: "/",
  });

  // Refresh token cookie (long-lived)
  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "strict" : "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: "/",
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

    if (!token) {
      return res.status(401).json({
        error: "Access token required",
        code: "NO_TOKEN",
      });
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
      return res.status(401).json({
        error: "Invalid token - user not found or deactivated",
        code: "USER_NOT_FOUND",
      });
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
      return res.status(401).json({
        error: "Token expired",
        code: "TOKEN_EXPIRED",
      });
    }
    return res.status(403).json({
      error: "Invalid token",
      code: "INVALID_TOKEN",
    });
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
      return res.status(401).json({
        error: "Refresh token required",
        code: "NO_REFRESH_TOKEN",
      });
    }

    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as any;

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { id: true, name: true, email: true, role: true },
    });

    if (!user) {
      return res.status(401).json({
        error: "Invalid refresh token",
        code: "INVALID_REFRESH_TOKEN",
      });
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
      return res.status(401).json({
        error: "Refresh token expired",
        code: "REFRESH_TOKEN_EXPIRED",
      });
    }
    return res.status(403).json({
      error: "Invalid refresh token",
      code: "INVALID_REFRESH_TOKEN",
    });
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
    return res.status(403).json({
      error: "Admin access required",
      code: "ADMIN_REQUIRED",
    });
  }
  next();
};

export const requireSuperAdmin = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  if (!req.user || req.user.role !== "super_admin") {
    return res.status(403).json({
      error: "Super admin access required",
      code: "SUPER_ADMIN_REQUIRED",
    });
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
    return res.status(403).json({
      error: "Manager or admin access required",
      code: "MANAGER_OR_ADMIN_REQUIRED",
    });
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
        return res.status(403).json({
          error: "You can only manage users assigned to you",
          code: "INSUFFICIENT_PERMISSIONS",
        });
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
    return res.status(401).json({
      error: "Authentication required",
      code: "AUTH_REQUIRED",
    });
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
    return res.status(401).json({
      error: "Authentication required",
      code: "AUTH_REQUIRED",
    });
  }

  if (!req.user.isEmailVerified) {
    return res.status(403).json({
      error: "Email verification required",
      code: "EMAIL_NOT_VERIFIED",
      email: req.user.email,
    });
  }
  next();
};
