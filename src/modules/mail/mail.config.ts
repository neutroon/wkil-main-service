import nodemailer from "nodemailer";
import { logger } from "@utils/logger";
import { env } from "@config/env";

/**
 * Production-grade SMTP Configuration
 * This bridge connects Wkil to your mailing provider via Nodemailer.
 */

export const mailer = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE, // true for port 465, false for other ports
  auth: {
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
  },
});

// Verify connection on startup (optional but recommended for production)
mailer.verify((error, success) => {
  if (error) {
    logger.error("SMTP Connection failed", { error });
  } else {
    logger.info("SMTP Connection established successfully");
  }
});


