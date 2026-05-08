import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  classifyHttpRetry,
  classifyNetworkRetry,
} from "./retryPolicy";

describe("integration retry policy", () => {
  it("retries transient HTTP statuses only", () => {
    expect(classifyHttpRetry(429)).toEqual({
      retryable: true,
      reason: "retryable_http_429",
    });
    expect(classifyHttpRetry(503)).toEqual({
      retryable: true,
      reason: "retryable_http_503",
    });
    expect(classifyHttpRetry(400)).toEqual({
      retryable: false,
      reason: "non_retryable_http_400",
    });
    expect(classifyHttpRetry(404)).toEqual({
      retryable: false,
      reason: "non_retryable_http_404",
    });
  });

  it("retries transient network failures but not permanent DNS/config failures", () => {
    expect(classifyNetworkRetry(new Error("ECONNRESET"))).toEqual({
      retryable: true,
      reason: "retryable_network_error",
    });
    expect(classifyNetworkRetry(new Error("getaddrinfo EAI_AGAIN api.example.com"))).toEqual({
      retryable: true,
      reason: "retryable_network_error",
    });
    expect(classifyNetworkRetry(new Error("getaddrinfo ENOTFOUND test.com"))).toEqual({
      retryable: false,
      reason: "non_retryable_network_error",
    });
  });

  it("caps exponential backoff", () => {
    expect(backoffDelayMs(1)).toBe(250);
    expect(backoffDelayMs(3)).toBe(1000);
    expect(backoffDelayMs(20)).toBe(1000);
  });
});
