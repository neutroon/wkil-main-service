import { Request, Response } from "express";
import bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import path from "path";
import prisma from "@config/prisma";
import {
  createUser,
  loginUser,
  getUserById,
  getAllUsers,
  updateUserRole,
  updateCurrentUserProfile,
  changeUserPassword,
  deactivateCurrentUser,
  deactivateUser,
  reactivateUser,
  permanentlyDeleteUser,
  addEmailToCurrentUser,
  resendEmailVerificationForCurrentUser,
} from "../user/user.service";
import * as authService from "../core/auth.service";
import {
  setAuthCookies,
  clearAuthCookies,
  generateAccessToken,
  generateRefreshToken,
} from "@modules/auth/core/auth.middleware";
import { uploadToR2, deleteFromR2 } from "@modules/media/services/r2Storage.service";
import { logger } from "@utils/logger";
import { AppError } from "@middlewares/errorHandler.middleware";

export const registerUser = async (req: Request, res: Response) => {
  const { name, email, password, role } = req.body;
  const user = await createUser(name, email, password, role);

  // Auto-login: Generate tokens
  const accessToken = generateAccessToken({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isSocialUser: false,
  });

  const refreshToken = generateRefreshToken({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isSocialUser: false,
  });

  // Refresh Token Rotation: Store hash in DB
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(refreshToken, salt);
  await prisma.user.update({
    where: { id: user.id },
    data: { 
      refreshTokenHash: hash,
      previousRefreshTokenHash: null,
      refreshTokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      rotatedAt: new Date()
    }
  });

  // Set HTTP-only cookies
  setAuthCookies(res, accessToken, refreshToken);

  res.status(201).json({
    message: "User created successfully",
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      isEmailVerified: user.isEmailVerified,
      lastVerificationSentAt: user.lastVerificationSentAt,
      isBusinessProfileCreated: user.isBusinessProfileCreated,
    },
  });
};

export const loginUserController = async (req: Request, res: Response) => {
  const { email, password } = req.body;
  const result = await loginUser(email, password);

  // Identity Lifecycle: Proactively trigger verification email if unverified
  if (!result.isEmailVerified) {
    authService.resendVerification(email).catch((err) => {
      logger.info("Auto-verification email suppressed or failed on login", {
        email,
        reason: err.message,
      });
    });
  }

  // Refresh Token Rotation: Store hash in DB
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(result.refreshToken, salt);
  await prisma.user.update({
    where: { id: result.id },
    data: { 
      refreshTokenHash: hash,
      previousRefreshTokenHash: null,
      refreshTokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      rotatedAt: new Date()
    }
  });

  // Set HTTP-only cookies
  setAuthCookies(res, result.accessToken, result.refreshToken);

  res.status(200).json({
    message: "User Login successful",
    user: {
      id: result.id,
      email: result.email,
      name: result.name,
      role: result.role,
      isEmailVerified: result.isEmailVerified,
      lastVerificationSentAt: result.lastVerificationSentAt,
      isBusinessProfileCreated: result.isBusinessProfileCreated,
    },
  });
};

export const getCurrentUser = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const user = await getUserById(userId);
  if (!user) {
    throw new AppError("User not found", 404);
  }
  res.status(200).json(user);
};

export const updateCurrentUser = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const user = await updateCurrentUserProfile(userId, req.body);
  if (!user) {
    throw new AppError("User not found", 404);
  }

  res.status(200).json({
    message: "Profile updated successfully",
    user,
  });
};

export const changeCurrentUserPassword = async (
  req: Request,
  res: Response,
) => {
  const userId = (req as any).user.id;
  const { currentPassword, newPassword } = req.body;

  const user = await changeUserPassword(
    userId,
    currentPassword,
    newPassword,
  );
  if (!user) {
    throw new AppError("User not found", 404);
  }

  const accessToken = generateAccessToken({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isSocialUser: user.isSocialUser,
  });
  const refreshToken = generateRefreshToken({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isSocialUser: user.isSocialUser,
  });

  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(refreshToken, salt);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      refreshTokenHash: hash,
      previousRefreshTokenHash: null,
      refreshTokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      rotatedAt: new Date(),
    },
  });

  setAuthCookies(res, accessToken, refreshToken);

  res.status(200).json({
    message: "Password changed successfully",
    user,
  });
};

export const deleteCurrentUserAccount = async (
  req: Request,
  res: Response,
) => {
  const userId = (req as any).user.id;
  await deactivateCurrentUser(userId);
  clearAuthCookies(res);
  res.status(200).json({ message: "Account deleted successfully" });
};

export const addEmail = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { email } = req.body;
  const user = await addEmailToCurrentUser(userId, email);
  res.status(200).json({
    message: "Email added. Please verify it to unlock password reset and notifications.",
    user,
  });
};

export const resendEmailVerification = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const result = await resendEmailVerificationForCurrentUser(userId);
  res.status(200).json(result);
};

const AVATAR_ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Upload (or replace) the current user's avatar. Accepts a single image file
 * via multipart/form-data under the field "file". The file is streamed to
 * Cloudflare R2 under `avatars/user_{id}/...` and the resulting public URL
 * is stored on `User.avatar`. Any previous avatar we uploaded is deleted
 * from R2 to avoid orphaned objects.
 */
export const uploadCurrentUserAvatar = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const file = (req as any).file as Express.Multer.File | undefined;

  if (!file) {
    throw new AppError("No file provided", 400, true, "AVATAR_NO_FILE");
  }
  if (!AVATAR_ALLOWED_MIME.has(file.mimetype)) {
    throw new AppError(
      `Unsupported image type: ${file.mimetype}. Use JPEG, PNG, WEBP, or GIF.`,
      400,
      true,
      "AVATAR_UNSUPPORTED_TYPE",
    );
  }
  if (file.size > AVATAR_MAX_BYTES) {
    throw new AppError(
      `Avatar must be ${AVATAR_MAX_BYTES / 1024 / 1024}MB or smaller.`,
      400,
      true,
      "AVATAR_TOO_LARGE",
    );
  }

  // Look up the current avatar so we can delete it from R2 (only if we
  // previously uploaded it; skip for foreign URLs like FB/Google avatars).
  const current = await prisma.user.findFirst({
    where: { id: userId, isActive: true },
    select: { avatar: true },
  });

  const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
  const safeExt = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)
    ? ext
    : ".jpg";
  const key = `avatars/user_${userId}/${randomUUID()}${safeExt}`;

  const publicUrl = await uploadToR2(key, file.buffer, file.mimetype);

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { avatar: publicUrl },
    select: { avatar: true },
  });

  // Best-effort cleanup of the previous avatar. Only delete if it was hosted on
  // our R2 (i.e. it starts with the R2 public URL). Foreign avatars (FB, Google)
  // are left alone — they're not our objects to delete.
  if (current?.avatar) {
    try {
      const { R2_PUBLIC_URL } = await import("@modules/media/r2");
      if (current.avatar.startsWith(R2_PUBLIC_URL)) {
        const oldKey = current.avatar.slice(R2_PUBLIC_URL.length + 1);
        if (oldKey.startsWith(`avatars/user_${userId}/`)) {
          await deleteFromR2(oldKey);
        }
      }
    } catch (err) {
      logger.warn("Failed to delete previous avatar from R2 (non-blocking)", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  res.status(200).json({
    message: "Avatar updated successfully.",
    avatar: updated.avatar,
  });
};

/**
 * Remove the current user's avatar. After this, the avatar falls back to
 * the user's initials everywhere.
 */
export const deleteCurrentUserAvatar = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const current = await prisma.user.findFirst({
    where: { id: userId, isActive: true },
    select: { avatar: true },
  });
  if (!current) {
    throw new AppError("User not found", 404, true, "USER_NOT_FOUND");
  }

  await prisma.user.update({
    where: { id: userId },
    data: { avatar: null },
  });

  if (current.avatar) {
    try {
      const { R2_PUBLIC_URL } = await import("@modules/media/r2");
      if (current.avatar.startsWith(R2_PUBLIC_URL)) {
        const oldKey = current.avatar.slice(R2_PUBLIC_URL.length + 1);
        if (oldKey.startsWith(`avatars/user_${userId}/`)) {
          await deleteFromR2(oldKey);
        }
      }
    } catch (err) {
      logger.warn("Failed to delete avatar from R2 (non-blocking)", {
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  res.status(200).json({ message: "Avatar removed." });
};

export const getUsers = async (req: Request, res: Response) => {
  const { includeInactive } = req.query as any;
  const users = await getAllUsers(includeInactive);
  res.status(200).json(users);
};

export const getUserByIdController = async (req: Request, res: Response) => {
  const { id } = req.params as any;
  const { includeInactive } = req.query as any;
  const user = await getUserById(id, includeInactive);
  if (!user) {
    throw new AppError("User not found", 404);
  }
  res.status(200).json(user);
};

export const updateUser = async (req: Request, res: Response) => {
  const { id } = req.params as any;
  const { role, name, email, plan, monthlyQuota, monthlyCreditQuota } = req.body;
  const user = await updateUserRole(
    id,
    role,
    name,
    email,
    plan,
    monthlyQuota,
    monthlyCreditQuota,
  );
  res.status(200).json({
    message: "User updated successfully",
    user,
  });
};

export const deactivateUserController = async (req: Request, res: Response) => {
  const { id } = req.params as any;
  const user = await deactivateUser(id);
  res.status(200).json({
    message: "User deactivated successfully",
    user,
  });
};

export const reactivateUserController = async (req: Request, res: Response) => {
  const { id } = req.params as any;
  const user = await reactivateUser(id);
  res.status(200).json({
    message: "User reactivated successfully",
    user,
  });
};

export const permanentlyDeleteUserController = async (
  req: Request,
  res: Response,
) => {
  const { id } = req.params as any;
  await permanentlyDeleteUser(id);
  res.status(200).json({ message: "User permanently deleted successfully" });
};
