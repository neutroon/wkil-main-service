import { Request, Response } from "express";
import * as authService from "./auth.service";
import {
  authenticateSocialUser,
  verifyFacebookAccessToken,
  verifyGoogleIdToken,
} from "./socialAuth.service";

/**
 * Production-grade Authentication & Identity Controller
 * Handles high-fidelity security handshakes for verification and recovery.
 */

/**
 * Handles email verification request.
 */
export const verifyEmail = async (req: Request, res: Response) => {
  const { token } = req.query;
  const user = await authService.verifyEmail(token as string);

  res.status(200).json({
    message: "Email verified successfully",
    user,
  });
};

/**
 * Handles forgot password request (enumeration protected).
 */
export const forgotPassword = async (req: Request, res: Response) => {
  const { email } = req.body;
  const result = await authService.forgotPassword(email);

  // Always 200 to prevent user enumeration
  res.status(200).json(result);
};

/**
 * Handles password reset request.
 */
export const resetPassword = async (req: Request, res: Response) => {
  const { token, newPassword } = req.body;
  const user = await authService.resetPassword(token, newPassword);

  res.status(200).json({
    message: "Password reset successfully",
    user: { id: user.id, email: user.email },
  });
};

/**
 * Handles resending verification email.
 */
export const resendVerification = async (req: Request, res: Response) => {
  const { email } = req.body;
  const result = await authService.resendVerification(email);

  res.status(200).json(result);
};

const sendSocialAuthResponse = async (req: Request, res: Response, provider: "google" | "facebook") => {
  const { token } = req.body;
  const profile =
    provider === "google"
      ? await verifyGoogleIdToken(token)
      : await verifyFacebookAccessToken(token);

  const user = await authenticateSocialUser(provider, profile);
  await authService.issueAuthSession(res, user);

  res.status(200).json({
    message: "Social authentication successful",
    user,
  });
};

export const googleSocialAuth = async (req: Request, res: Response) => {
  await sendSocialAuthResponse(req, res, "google");
};

export const facebookSocialAuth = async (req: Request, res: Response) => {
  await sendSocialAuthResponse(req, res, "facebook");
};


