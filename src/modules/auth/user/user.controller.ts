import { Request, Response } from "express";
import bcrypt from "bcrypt";
import prisma from "@config/prisma";
import {
  createUser,
  loginUser,
  getUserById,
  getAllUsers,
  updateUserRole,
  deactivateUser,
  reactivateUser,
  permanentlyDeleteUser,
} from "../user/user.service";
import * as authService from "../core/auth.service";
import {
  setAuthCookies,
  clearAuthCookies,
  generateAccessToken,
  generateRefreshToken,
} from "@modules/auth/core/auth.middleware";
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
  });

  const refreshToken = generateRefreshToken({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
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
  const { role, name, email, plan, monthlyQuota } = req.body;
  const user = await updateUserRole(id, role, name, email, plan, monthlyQuota);
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
