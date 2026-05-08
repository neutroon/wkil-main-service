import { describe, expect, it } from "vitest";
import {
  assertExternalApiUrlLooksSafe,
  filterExternalArgsBySchema,
  maskExternalHeaders,
  mergeHeaderUpdate,
  toCanonicalVerificationRead,
} from "./externalData.service";

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

describe("external source production hardening helpers", () => {
  it("rejects localhost and private IP URLs", () => {
    expect(() => assertExternalApiUrlLooksSafe("http://localhost:3000/data")).toThrow();
    expect(() => assertExternalApiUrlLooksSafe("http://127.0.0.1/data")).toThrow();
    expect(() => assertExternalApiUrlLooksSafe("http://10.0.0.2/data")).toThrow();
    expect(() => assertExternalApiUrlLooksSafe("https://api.example.com/data")).not.toThrow();
  });

  it("masks headers before sending sources back to the browser", () => {
    expect(maskExternalHeaders({ Authorization: "Bearer secret" })).toEqual({
      Authorization: "********",
    });
  });

  it("preserves existing encrypted headers when the update payload sends a mask", () => {
    const merged = mergeHeaderUpdate(
      { Authorization: "enc:v1:stored-secret" },
      { Authorization: "********", "X-Mode": "live" },
    );

    expect(merged).toEqual({
      Authorization: "enc:v1:stored-secret",
      "X-Mode": expect.any(String),
    });
  });

  it("drops model args when a live data source declares no params", () => {
    expect(filterExternalArgsBySchema(undefined, { q: "invented", id: "123" })).toEqual({});
    expect(filterExternalArgsBySchema({}, { q: "invented", id: "123" })).toEqual({});
  });

  it("allows only model args declared by the expected param schema", () => {
    expect(
      filterExternalArgsBySchema(
        { orderId: "Order identifier", email: "Customer email" },
        { orderId: "A-1", email: "x@example.com", q: "extra" },
      ),
    ).toEqual({
      orderId: "A-1",
      email: "x@example.com",
    });
  });
});

