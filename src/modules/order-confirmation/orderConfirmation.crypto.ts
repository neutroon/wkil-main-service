import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;
const SIGNATURE_PREFIX = "v1=";

export function computeOrderWebhookSignature(
  timestamp: string,
  rawBody: Buffer,
  secret: string,
): string {
  const payload = `${timestamp}.${rawBody.toString("utf8")}`;
  const digest = createHmac("sha256", secret).update(payload, "utf8").digest("hex");

  return `${SIGNATURE_PREFIX}${digest}`;
}

export function verifyOrderWebhookSignature(params: {
  rawBody: Buffer;
  timestamp: string | undefined;
  signature: string | undefined;
  secret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): boolean {
  const {
    rawBody,
    timestamp,
    signature,
    secret,
    nowSeconds = Math.floor(Date.now() / 1000),
    toleranceSeconds = DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
  } = params;

  if (!Buffer.isBuffer(rawBody) || typeof timestamp !== "string" || typeof signature !== "string") {
    return false;
  }

  if (!/^\d+$/.test(timestamp)) {
    return false;
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    return false;
  }

  if (!Number.isFinite(nowSeconds) || !Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) {
    return false;
  }

  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    return false;
  }

  const signatureMatch = /^v1=([0-9a-f]{64})$/i.exec(signature);
  if (!signatureMatch) {
    return false;
  }

  const expectedDigest = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody.toString("utf8")}`, "utf8")
    .digest();
  const providedDigest = Buffer.from(signatureMatch[1], "hex");

  if (expectedDigest.length !== providedDigest.length) {
    return false;
  }

  return timingSafeEqual(expectedDigest, providedDigest);
}

export function hashOrderActionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function issueOrderActionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");

  return {
    token,
    tokenHash: hashOrderActionToken(token),
  };
}
