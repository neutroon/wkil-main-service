import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  decryptFacebookSecret,
  encryptFacebookSecret,
} from "../core/tokenCrypto";

describe("tokenCrypto", () => {
  const originalKey = process.env.FB_TOKEN_ENCRYPTION_KEY;

  afterEach(() => {
    process.env.FB_TOKEN_ENCRYPTION_KEY = originalKey;
  });

  it("passes through plaintext when no key is set", () => {
    delete process.env.FB_TOKEN_ENCRYPTION_KEY;
    const t = "plain-token";
    expect(encryptFacebookSecret(t)).toBe(t);
    expect(decryptFacebookSecret(t)).toBe(t);
  });

  it("round-trips with 64-char hex key", () => {
    process.env.FB_TOKEN_ENCRYPTION_KEY = "a".repeat(64);
    const plain = "user-access-token-xyz";
    const enc = encryptFacebookSecret(plain);
    expect(enc).not.toBe(plain);
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(decryptFacebookSecret(enc)).toBe(plain);
  });
});

