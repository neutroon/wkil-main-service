import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import { verifyMetaWebhookSignature } from "./metaWebhook";

describe("verifyMetaWebhookSignature", () => {
  const secret = "test_app_secret";
  const body = Buffer.from('{"object":"page"}', "utf8");

  it("accepts valid sha256 signature", () => {
    const sig =
      "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyMetaWebhookSignature(body, sig, secret)).toBe(true);
  });

  it("rejects wrong secret", () => {
    const sig =
      "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyMetaWebhookSignature(body, sig, "other")).toBe(false);
  });

  it("rejects tampered body", () => {
    const sig =
      "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    const tampered = Buffer.from('{"object":"user"}', "utf8");
    expect(verifyMetaWebhookSignature(tampered, sig, secret)).toBe(false);
  });

  it("rejects missing or malformed signature header", () => {
    expect(verifyMetaWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyMetaWebhookSignature(body, "md5=abc", secret)).toBe(false);
  });
});
