import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeOrderWebhookSignature,
  hashOrderActionToken,
  issueOrderActionToken,
  verifyOrderWebhookSignature,
} from "./orderConfirmation.crypto";

describe("order confirmation crypto", () => {
  it("verifies the exact raw body and rejects a tampered body", () => {
    const rawBody = Buffer.from('{"eventId":"evt_1"}', "utf8");
    const timestamp = "1700000000";
    const signature = computeOrderWebhookSignature(timestamp, rawBody, "secret");

    expect(
      verifyOrderWebhookSignature({
        rawBody,
        timestamp,
        signature,
        secret: "secret",
        nowSeconds: 1700000000,
      }),
    ).toBe(true);

    expect(
      verifyOrderWebhookSignature({
        rawBody: Buffer.from('{"eventId":"evt_2"}', "utf8"),
        timestamp,
        signature,
        secret: "secret",
        nowSeconds: 1700000000,
      }),
    ).toBe(false);
  });

  it("rejects signatures generated with a different secret", () => {
    const rawBody = Buffer.from("payload", "utf8");
    const timestamp = "1700000000";
    const signature = computeOrderWebhookSignature(timestamp, rawBody, "secret");

    expect(
      verifyOrderWebhookSignature({
        rawBody,
        timestamp,
        signature,
        secret: "different-secret",
        nowSeconds: 1700000000,
      }),
    ).toBe(false);
  });

  it("rejects malformed signature and timestamp headers", () => {
    const rawBody = Buffer.from("payload", "utf8");
    const validTimestamp = "1700000000";
    const validSignature = computeOrderWebhookSignature(validTimestamp, rawBody, "secret");
    const baseParams = {
      rawBody,
      timestamp: validTimestamp,
      signature: validSignature,
      secret: "secret",
      nowSeconds: 1700000000,
    };

    for (const signature of [undefined, "", "v1", "v2=abc", "v1=not-hex", "v1=00"]) {
      expect(
        verifyOrderWebhookSignature({ ...baseParams, signature }),
        `signature ${String(signature)} should be rejected`,
      ).toBe(false);
    }

    for (const timestamp of [undefined, "", "not-a-number", "1700000000.5", "1e9"]) {
      expect(
        verifyOrderWebhookSignature({ ...baseParams, timestamp }),
        `timestamp ${String(timestamp)} should be rejected`,
      ).toBe(false);
    }
  });

  it("rejects timestamps outside the default five-minute window in either direction", () => {
    const rawBody = Buffer.from("payload", "utf8");
    const nowSeconds = 1700000000;

    for (const timestamp of [String(nowSeconds - 301), String(nowSeconds + 301)]) {
      const signature = computeOrderWebhookSignature(timestamp, rawBody, "secret");

      expect(
        verifyOrderWebhookSignature({
          rawBody,
          timestamp,
          signature,
          secret: "secret",
          nowSeconds,
        }),
        `timestamp ${timestamp} should be rejected`,
      ).toBe(false);
    }
  });

  it("accepts timestamps at the edge of the default tolerance", () => {
    const rawBody = Buffer.from("payload", "utf8");
    const nowSeconds = 1700000000;

    for (const timestamp of [String(nowSeconds - 300), String(nowSeconds + 300)]) {
      const signature = computeOrderWebhookSignature(timestamp, rawBody, "secret");

      expect(
        verifyOrderWebhookSignature({
          rawBody,
          timestamp,
          signature,
          secret: "secret",
          nowSeconds,
        }),
      ).toBe(true);
    }
  });

  it("issues high-entropy opaque tokens and returns only a hash for persistence", () => {
    const first = issueOrderActionToken();
    const second = issueOrderActionToken();

    expect(first.token).not.toBe(second.token);
    expect(first.token.length).toBeGreaterThanOrEqual(32);
    expect(second.token.length).toBeGreaterThanOrEqual(32);
    expect(first.tokenHash).not.toBe(first.token);
    expect(second.tokenHash).not.toBe(second.token);
    expect(first.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.tokenHash).toBe(hashOrderActionToken(first.token));
    expect(second.tokenHash).toBe(hashOrderActionToken(second.token));
    expect(first.tokenHash).toBe(
      createHash("sha256").update(first.token, "utf8").digest("hex"),
    );
  });
});
