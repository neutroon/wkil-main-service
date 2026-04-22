import nodemailer from "nodemailer";
import { logger } from "../utils/logger";

/**
 * Production-grade SMTP Configuration
 * This bridge connects PagesPilot to your mailing provider via Nodemailer.
 */

const smtpConfig = {
  host: process.env.SMTP_HOST || "smtp.example.com",
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: process.env.SMTP_SECURE === "true", // true for port 465, false for other ports
  auth: {
    user: process.env.SMTP_USER || "user@example.com",
    pass: process.env.SMTP_PASS || "password",
  },
};

export const mailer = nodemailer.createTransport(smtpConfig);

// Verify connection on startup (optional but recommended for production)
mailer.verify((error, success) => {
  if (error) {
    logger.error("SMTP Connection failed", { error });
  } else {
    logger.info("SMTP Connection established successfully");
  }
});
