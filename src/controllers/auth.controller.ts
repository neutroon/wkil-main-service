import { Request, Response } from "express";
import * as authService from "../services/auth.service";

/**
 * Production-grade Authentication & Identity Controller
 * Handles high-fidelity security handshakes for verification and recovery.
 */

/**
 * Handles email verification request.
 */
export const verifyEmail = async (req: Request, res: Response) => {
  try {
    const { token } = req.query;

    if (!token || typeof token !== "string") {
      return res.status(400).json({ error: "Verification token is required" });
    }

    const user = await authService.verifyEmail(token);

    res.status(200).json({
      message: "Email verified successfully",
      user,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

/**
 * Handles forgot password request (enumeration protected).
 */
export const forgotPassword = async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const result = await authService.forgotPassword(email);

    // Always 200 to prevent user enumeration
    res.status(200).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

/**
 * Handles password reset request.
 */
export const resetPassword = async (req: Request, res: Response) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: "Token and new password are required" });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters long" });
    }

    const user = await authService.resetPassword(token, newPassword);

    res.status(200).json({
      message: "Password reset successfully",
      user: { id: user.id, email: user.email },
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

/**
 * Handles resending verification email.
 */
export const resendVerification = async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    const result = await authService.resendVerification(email);

    res.status(200).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};
