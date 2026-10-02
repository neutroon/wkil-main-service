import { describe, expect, it } from "vitest";
import { WhatsAppTemplateRejectedError } from "./whatsapp.delivery-errors";
describe("definite WhatsApp template rejections", () => {
  it("stops a known permanent parameter failure even when HTTP status is temporary", () => {
    const failure = new WhatsAppTemplateRejectedError(503, { error: { code: 131008, message: "private recipient detail", fbtrace_id: "trace" } });
    expect(failure.retryable).toBe(false); expect(failure.providerCode).toBe(131008);
    expect(failure.message).not.toContain("private"); expect(failure.message).not.toContain("trace");
  });
  it("retries documented throughput rejections despite HTTP 400", () => {
    expect(new WhatsAppTemplateRejectedError(400, { error: { code: 130429 } }).retryable).toBe(true);
    expect(new WhatsAppTemplateRejectedError(400, { error: { code: 131016 } }).retryable).toBe(true);
  });
  it("blocks unknown ordinary client errors and retries definite server errors", () => {
    expect(new WhatsAppTemplateRejectedError(400, {}).retryable).toBe(false);
    expect(new WhatsAppTemplateRejectedError(500, {}).retryable).toBe(true);
    expect(new WhatsAppTemplateRejectedError(500, { error: { code: 190 } }).retryable).toBe(false);
  });
});
