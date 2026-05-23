import { mailer } from "./mail.config";
import { logger } from "@utils/logger";
import { AppError } from "@middlewares/errorHandler.middleware";

import { env } from "@config/env";

const FRONTEND_URL = env.FRONTEND_URL;
const MAIL_FROM = env.MAIL_FROM;

/**
 * Production-grade Mailing Service
 * Handles the delivery of security handshakes and system notifications.
 */

export const sendVerificationEmail = async (email: string, name: string, token: string) => {
  const verificationUrl = `${FRONTEND_URL}/auth/verify-email?token=${token}`;

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #d8d0c2; border-radius: 12px; background-color: #fffaf2;">
      <h2 style="color: #132322; margin-bottom: 16px;">Welcome to Wkil, ${name}!</h2>
      <p style="color: #475569; line-height: 1.6; margin-bottom: 24px;">
        Thank you for joining our platform. To get started and secure your account, please verify your email address by clicking the button below:
      </p>
      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${verificationUrl}" style="background-color: #0E7C73; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">Verify Email Address</a>
      </div>
      <p style="color: #64748b; font-size: 14px; line-height: 1.5;">
        This link will expire in 24 hours. If you did not create an account with Wkil, you can safely ignore this email.
      </p>
      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
      <p style="color: #94a3b8; font-size: 12px; text-align: center;">
        &copy; 2026 Wkil. All rights reserved.
      </p>
    </div>
  `;

  try {
    await mailer.sendMail({
      from: MAIL_FROM,
      to: email,
      subject: "Verify your Wkil account",
      html,
    });
    logger.info("Verification email sent successfully", { email });
  } catch (error) {
    throw new AppError("Could not send verification email", 502);
  }
};

export const sendPasswordResetEmail = async (email: string, name: string, token: string) => {
  const resetUrl = `${FRONTEND_URL}/auth/reset-password?token=${token}`;

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #d8d0c2; border-radius: 12px; background-color: #fffaf2;">
      <h2 style="color: #132322; margin-bottom: 16px;">Password Reset Request</h2>
      <p style="color: #475569; line-height: 1.6; margin-bottom: 24px;">
        Hello ${name}, we received a request to reset your password. Click the button below to choose a new password:
      </p>
      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${resetUrl}" style="background-color: #ef4444; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">Reset Password</a>
      </div>
      <p style="color: #64748b; font-size: 14px; line-height: 1.5;">
        This link will expire in 1 hour. If you did not request a password reset, please change your password immediately or contact support.
      </p>
      <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
      <p style="color: #94a3b8; font-size: 12px; text-align: center;">
        &copy; 2026 Wkil. All rights reserved.
      </p>
    </div>
  `;

  try {
    await mailer.sendMail({
      from: MAIL_FROM,
      to: email,
      subject: "Password Reset Request",
      html,
    });
    logger.info("Password reset email sent successfully", { email });
  } catch (error) {
    throw new AppError("Could not send password reset email", 502);
  }
};



