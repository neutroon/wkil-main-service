import { describe, expect, it } from "vitest";
import { toCanonicalVerificationRead } from "./externalData.service";

describe("toCanonicalVerificationRead", () => {
  it("marks non-empty JSON without explicit status as verified (data returned)", () => {
    const data = {
      id: "order_123",
      customer: "Hesham",
      program: "الدعم النفسى بالفنون",
    };
    expect(toCanonicalVerificationRead(data)).toEqual({
      verification: "verified",
      reason: "data_returned",
    });
  });

  it("treats empty object as failed (no data)", () => {
    expect(toCanonicalVerificationRead({})).toEqual({
      verification: "failed",
      reason: "no_data_found",
    });
  });

  it("treats provider success false as failed", () => {
    expect(toCanonicalVerificationRead({ success: false, message: "nope" })).toEqual({
      verification: "failed",
      reason: "provider_success_false",
    });
  });

  it("treats explicit error status as failed", () => {
    expect(toCanonicalVerificationRead({ status: "error" })).toEqual({
      verification: "failed",
      reason: "provider_status_error",
    });
  });
});

