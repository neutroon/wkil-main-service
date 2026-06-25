import { mailer } from "./mail.config";
import { logger } from "@utils/logger";
import { AppError } from "@middlewares/errorHandler.middleware";

import { env } from "@config/env";

const FRONTEND_URL = env.FRONTEND_URL;
const MAIL_FROM = env.MAIL_FROM;

type MailerError = Error & {
  code?: string;
  command?: string;
  responseCode?: number;
  response?: string;
  errno?: string;
  address?: string;
  port?: number;
  syscall?: string;
  hostname?: string;
};

const mailErrorMeta = (error: unknown) => {
  const mailError = error as MailerError;

  return {
    name: mailError?.name,
    message: mailError?.message,
    code: mailError?.code,
    command: mailError?.command,
    responseCode: mailError?.responseCode,
    response: mailError?.response,
    errno: mailError?.errno,
    address: mailError?.address,
    port: mailError?.port,
    syscall: mailError?.syscall,
    hostname: mailError?.hostname,
  };
};

/**
 * Production-grade Mailing Service
 * Handles the delivery of security handshakes and system notifications.
 */

type VerificationEmailKind = "signup" | "add-email";

const VERIFICATION_EMAIL_COPY: Record<VerificationEmailKind, { subject: string; heading: string; intro: string; dismiss: string }> = {
  signup: {
    subject: "Verify your Wkil account",
    heading: "Welcome to Wkil",
    intro: "Thank you for joining our platform. To get started and secure your account, please verify your email address by clicking the button below:",
    dismiss: "If you did not create an account with Wkil, you can safely ignore this email.",
  },
  "add-email": {
    subject: "Verify your new email on Wkil",
    heading: "Confirm your email",
    intro: "You added this email to your existing Wkil account. To enable password reset, notifications, and other security features, please verify it by clicking the button below:",
    dismiss: "If you did not request this, you can safely ignore this email. Your account will remain active.",
  },
};

export const sendVerificationEmail = async (
  email: string,
  name: string,
  token: string,
  kind: VerificationEmailKind = "signup",
) => {
  const verificationUrl = `${FRONTEND_URL}/auth/verify-email?token=${token}`;
  const copy = VERIFICATION_EMAIL_COPY[kind];

  const html = `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #d8d0c2; border-radius: 12px; background-color: #fffaf2;">
      <h2 style="color: #132322; margin-bottom: 16px;">${copy.heading}, ${name}!</h2>
      <p style="color: #475569; line-height: 1.6; margin-bottom: 24px;">
        ${copy.intro}
      </p>
      <div style="text-align: center; margin-bottom: 24px;">
        <a href="${verificationUrl}" style="background-color: #0E7C73; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">Verify Email Address</a>
      </div>
      <p style="color: #64748b; font-size: 14px; line-height: 1.5;">
        ${copy.dismiss} This link will expire in 24 hours.
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
      subject: copy.subject,
      html,
    });
    logger.info("Verification email sent successfully", { email, kind });
  } catch (error) {
    logger.error("Verification email delivery failed", {
      email,
      kind,
      smtpHost: env.SMTP_HOST,
      smtpPort: env.SMTP_PORT,
      smtpSecure: env.SMTP_SECURE,
      error: mailErrorMeta(error),
    });
    throw new AppError("Could not send verification email", 502, true, "MAIL_DELIVERY_FAILED");
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
    logger.error("Password reset email delivery failed", {
      email,
      smtpHost: env.SMTP_HOST,
      smtpPort: env.SMTP_PORT,
      smtpSecure: env.SMTP_SECURE,
      error: mailErrorMeta(error),
    });
    throw new AppError("Could not send password reset email", 502, true, "MAIL_DELIVERY_FAILED");
  }
};



