import { Request, Response } from "express";
import {
  createUser,
  loginUser,
  getUserById,
  getAllUsers,
  updateUserRole,
  deactivateUser,
  reactivateUser,
  permanentlyDeleteUser,
} from "../services/user.service";
import * as authService from "../services/auth.service";
import {
  setAuthCookies,
  clearAuthCookies,
  generateAccessToken,
  generateRefreshToken,
  // setUserRoleCookies,
} from "../middlewares/auth.middleware";
import { logger } from "../utils/logger";

export const registerUser = async (req: Request, res: Response) => {
  try {
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

    // Set HTTP-only cookies
    setAuthCookies(res, accessToken, refreshToken);

    res.status(201).json({
      message: "User created successfully",
      accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        isEmailVerified: user.isEmailVerified,
        lastVerificationSentAt: user.lastVerificationSentAt,
      },
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const loginUserController = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const result = await loginUser(email, password);

    // Identity Lifecycle: Proactively trigger verification email if unverified
    if (!result.isEmailVerified) {
      authService.resendVerification(email).catch((err) => {
        // We log but don't fail the login (they will land on the pending page anyway)
        logger.info("Auto-verification email suppressed or failed on login", {
          email,
          reason: err.message,
        });
      });
    }

    // Set HTTP-only cookies
    setAuthCookies(res, result.accessToken, result.refreshToken);
    // setUserRoleCookies(res, result.role, result.role);

    res.status(200).json({
      message: "User Login successful",
      accessToken: result.accessToken,
      user: {
        id: result.id,
        email: result.email,
        role: result.role,
        isEmailVerified: result.isEmailVerified,
        lastVerificationSentAt: result.lastVerificationSentAt,
      },
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const getCurrentUser = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const user = await getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.status(200).json(user);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const getUsers = async (req: Request, res: Response) => {
  try {
    const { includeInactive } = req.query;
    const users = await getAllUsers(includeInactive === "true");
    res.status(200).json(users);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const getUserByIdController = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { includeInactive } = req.query;
    const user = await getUserById(parseInt(id), includeInactive === "true");
    if (!user) {
      res.status(404).json({ error: "User not found" });
    }
    res.status(200).json(user);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};
export const updateUser = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { role, name, email, plan, monthlyQuota } = req.body;
    const user = await updateUserRole(
      parseInt(id),
      role,
      name,
      email,
      plan,
      monthlyQuota,
    );
    res.status(200).json({
      message: "User updated successfully",
      user,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const deactivateUserController = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = await deactivateUser(parseInt(id));
    res.status(200).json({
      message: "User deactivated successfully",
      user,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const reactivateUserController = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = await reactivateUser(parseInt(id));
    res.status(200).json({
      message: "User reactivated successfully",
      user,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const permanentlyDeleteUserController = async (
  req: Request,
  res: Response,
) => {
  try {
    const { id } = req.params;
    await permanentlyDeleteUser(parseInt(id));
    res.status(200).json({ message: "User permanently deleted successfully" });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

export const logoutUser = async (req: Request, res: Response) => {
  try {
    clearAuthCookies(res);
    res.status(200).json({ message: "Logged out successfully" });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};
