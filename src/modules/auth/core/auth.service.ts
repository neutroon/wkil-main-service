import bcrypt from "bcrypt";
import prisma from "@config/prisma";
import { hashToken, generateRandomToken } from "@modules/auth/core/tokenCrypto";
import { sendVerificationEmail, sendPasswordResetEmail } from "@modules/mail/mail.service";
import { logger } from "@utils/logger";
import { AppError } from "@middlewares/errorHandler.middleware";

/**
 * Production-grade Identity Lifecycle Service
 * Handles email verification and secure account recovery.
 */

/**
 * Verifies a user's email address using a provided token.
 */
export const verifyEmail = async (token: string) => {
  const hashedToken = hashToken(token);
  
  logger.info("Email verification attempt started", { hashedToken });

  const user = await prisma.user.findFirst({
    where: {
      emailVerificationToken: hashedToken,
      isActive: true,
    },
  });

  if (!user) {
    logger.warn("Verification failed: Token mismatch or expired", { hashedToken });
    throw new AppError("Invalid or expired verification token", 400);
  }

  logger.info("Verification target user identified", { 
    userId: user.id, 
    email: user.email,
    currentStatus: user.isEmailVerified 
  });

  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: {
      isEmailVerified: true,
      emailVerificationToken: null,
    },
    select: {
      id: true,
      email: true,
      isEmailVerified: true,
      updatedAt: true
    },
  });

  logger.info("Database update successful: Email activated", { 
    userId: updatedUser.id, 
    isEmailVerified: updatedUser.isEmailVerified,
    newUpdatedAt: updatedUser.updatedAt
  });

  return updatedUser;
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

  const now = new Date();
  const cooldownPeriod = 60 * 1000; // 60 seconds

  if (user.lastVerificationSentAt && (now.getTime() - user.lastVerificationSentAt.getTime() < cooldownPeriod)) {
    const remaining = Math.ceil((cooldownPeriod - (now.getTime() - user.lastVerificationSentAt.getTime())) / 1000);
    throw new AppError(`Please wait ${remaining} seconds before requesting another email.`, 429);
  }

  const verificationToken = generateRandomToken();
  const hashedToken = hashToken(verificationToken);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerificationToken: hashedToken,
      lastVerificationSentAt: now,
    },
  });

  await sendVerificationEmail(user.email, user.name, verificationToken);

  return { message: "If the account is unverified, a new link has been sent." };
};







