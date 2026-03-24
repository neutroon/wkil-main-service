import { createHmac, timingSafeEqual } from "crypto";

/**
 * Verify Meta `X-Hub-Signature-256` against the raw request body (bytes must match what Meta signed).
 */
export function verifyMetaWebhookSignature(
  rawBody: Buffer | string | undefined | null,
  signatureHeader: string | undefined,
  appSecret: string | undefined,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  if (!appSecret) return false;

  const body =
    Buffer.isBuffer(rawBody) && rawBody.length > 0
      ? rawBody
      : Buffer.from(
          typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody ?? {}),
          "utf8",
        );

  const expectedHex = createHmac("sha256", appSecret)
    .update(body)
    .digest("hex");
  const receivedHex = signatureHeader.slice(7);

  try {
    const expected = Buffer.from(expectedHex, "hex");
    const received = Buffer.from(receivedHex, "hex");
    if (expected.length !== received.length) return false;
    return timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}
