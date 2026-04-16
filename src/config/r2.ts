import { S3Client } from "@aws-sdk/client-s3";
import { logger } from "../utils/logger";

if (!process.env.CF_ACCOUNT_ID || !process.env.R2_ACCESS_KEY || !process.env.R2_SECRET_KEY) {
  logger.warn("r2.config: R2 environment variables not set. Media Library will be unavailable.");
}

export const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY || "",
    secretAccessKey: process.env.R2_SECRET_KEY || "",
  },
});

export const R2_BUCKET = process.env.R2_BUCKET_NAME || "pagespilot-media-library";
export const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || "").replace(/\/$/, "");
