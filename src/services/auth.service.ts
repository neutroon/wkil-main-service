import bcrypt from "bcrypt";
import prisma from "../config/prisma";
import { hashToken, generateRandomToken } from "../utils/tokenCrypto";
import { sendVerificationEmail, sendPasswordResetEmail } from "./mail.service";
import { logger } from "../utils/logger";

/**
 * Production-grade Identity Lifecycle Service
 * Handles email verification and secure account recovery.
 */

/**
 * Verifies a user's email address using a provided token.
 */
export const verifyEmail = async (token: string) => {
  const hashedToken = hashToken(token);

  const user = await prisma.user.findFirst({
    where: {
      emailVerificationToken: hashedToken,
      isActive: true,
    },
  });

  if (!user) {
    throw new Error("Invalid or expired verification token");
  }

  return prisma.user.update({
    where: { id: user.id },
    data: {
      isEmailVerified: true,
      emailVerificationToken: null, // Clear token after successful use
    },
    select: {
      id: true,
      email: true,
      isEmailVerified: true,
    },
  });
};

/**
 * Initiates the password recovery flow.
 * Note: Returns success regardless of user existence to prevent account enumeration.
 */
export const forgotPassword = async (email: string) => {
  const user = await prisma.user.findUnique({
    where: { email, isActive: true },
  });

  if (!user) {
    logger.warn("Password reset attempted for non-existent or inactive email", { email });
    return { message: "If an account exists with that email, a reset link has been sent." };
  }

  const resetToken = generateRandomToken();
  const hashedToken = hashToken(resetToken);
  const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour expiry

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordResetToken: hashedToken,
      passwordResetExpires: expires,
    },
  });

  // Dispatch email
  await sendPasswordResetEmail(user.email, user.name, resetToken);

  return { message: "If an account exists with that email, a reset link has been sent." };
};

/**
 * Resets a user's password using a valid reset token.
 */
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
    throw new Error("Invalid or expired password reset token");
  }

  const hashedPassword = await bcrypt.hash(newPassword, 10);

  return prisma.user.update({
    where: { id: user.id },
    data: {
      password: hashedPassword,
      passwordResetToken: null,
      passwordResetExpires: null,
    },
    select: {
      id: true,
      email: true,
    },
  });
};

/**
 * Resends the verification email for an unverified account.
 */
export const resendVerification = async (email: string) => {
  const user = await prisma.user.findUnique({
    where: { email, isActive: true },
  });

  if (!user || user.isEmailVerified) {
    // If user doesn't exist or is already verified, we return success to prevent enumeration
    return { message: "If the account is unverified, a new link has been sent." };
  }

  const verificationToken = generateRandomToken();
  const hashedToken = hashToken(verificationToken);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerificationToken: hashedToken,
    },
  });

  await sendVerificationEmail(user.email, user.name, verificationToken);

  return { message: "If the account is unverified, a new link has been sent." };
};
