import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { AppError } from "../middlewares/errorHandler.middleware";

const PREFIX = "enc:v1:";
const ALGO = "aes-256-gcm";

/** 32-byte key: 64 hex chars or base64-encoded 32 bytes */
export function getFacebookTokenEncryptionKey(): Buffer | null {
  const raw = process.env.FB_TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  try {
    const b = Buffer.from(raw, "base64");
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

export function encryptFacebookSecret(plain: string): string {
  const key = getFacebookTokenEncryptionKey();
  if (!key) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptFacebookSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const key = getFacebookTokenEncryptionKey();
  if (!key) {
    throw new AppError(
      "FB_TOKEN_ENCRYPTION_KEY is required to decrypt Facebook tokens",
      500
    );
  }
  const raw = Buffer.from(stored.slice(PREFIX.length), "base64");
  if (raw.length < 12 + 16) {
    throw new AppError("Invalid encrypted token payload", 401);
  }
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}

/**
 * ── Identity Lifecycle Security (Production Grade) ──────────────────────────
 */

/** Generates a cryptographically secure, high-entropy token for emails. */
export function generateRandomToken(): string {
  return randomBytes(32).toString("hex");
}

/** Hashes a token using SHA-256 before database storage. */
export function hashToken(token: string): string {
  const { createHash } = require("crypto");
  return createHash("sha256").update(token).digest("hex");
}
