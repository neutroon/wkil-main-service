import crypto from "crypto";
import prisma from "@config/prisma";
import { logger } from "@utils/logger";

export type VerifiedWidgetUser = {
  id: string;
  name?: string;
  email?: string;
  phone?: string;
  avatar?: string;
};

type RawWidgetUser = {
  id: string;
  hash: string;
  name?: string;
  email?: string;
  phone?: string;
  avatar?: string;
};

/** Generate a new per-install identity secret (64-char hex). */
export function generateIdentitySecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** HMAC signature for a userId using a per-install secret. */
export function signUserIdentity(secret: string, userId: string): string {
  return crypto.createHmac("sha256", secret).update(String(userId)).digest("hex");
}

export function parseWidgetUser(raw: unknown): RawWidgetUser | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.id !== "string" || typeof obj.hash !== "string") return null;
  if (obj.id.length < 1 || obj.id.length > 128) return null;
  if (obj.hash.length < 16 || obj.hash.length > 256) return null;

  return {
    id: obj.id,
    hash: obj.hash,
    name: typeof obj.name === "string" ? obj.name.slice(0, 256) : undefined,
    email: typeof obj.email === "string" ? obj.email.slice(0, 256) : undefined,
    phone: typeof obj.phone === "string" ? obj.phone.slice(0, 64) : undefined,
    avatar: typeof obj.avatar === "string" ? obj.avatar.slice(0, 1024) : undefined,
  };
}

export function verifyWidgetUserIdentity(
  identitySecret: string,
  user: RawWidgetUser,
): VerifiedWidgetUser | null {
  const expectedHash = signUserIdentity(identitySecret, user.id);

  const expectedBuf = Buffer.from(expectedHash, "hex");
  const providedBuf = Buffer.from(user.hash, "hex");

  if (expectedBuf.length !== 32 || providedBuf.length !== 32) return null;
  if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) return null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    avatar: user.avatar,
  };
}

export function verifyWidgetUserFromRequest(
  identitySecret: string,
  rawUser: unknown,
): VerifiedWidgetUser | null {
  const parsed = parseWidgetUser(rawUser);
  if (!parsed) return null;

  const verified = verifyWidgetUserIdentity(identitySecret, parsed);
  if (!verified) {
    logger.warn("widget.identity_verification_failed", {
      userId: parsed.id.slice(0, 16),
    });
    return null;
  }

  return verified;
}

export async function syncVerifiedUserEmail(
  customerId: number,
  email: string,
): Promise<void> {
  await prisma.customer.updateMany({
    where: { id: customerId, email: null },
    data: { email },
  });
}

/**
 * Always overwrite customer profile fields with verified user data.
 * Called on every verified message so the profile stays current.
 */
export async function syncVerifiedUserProfile(
  customerId: number,
  user: VerifiedWidgetUser,
): Promise<void> {
  const data: Record<string, string> = {};
  if (user.name) data.displayName = user.name;
  if (user.phone) data.phone = user.phone;
  if (user.email) data.email = user.email;
  if (Object.keys(data).length === 0) return;

  await prisma.customer.update({
    where: { id: customerId },
    data,
  });
}
