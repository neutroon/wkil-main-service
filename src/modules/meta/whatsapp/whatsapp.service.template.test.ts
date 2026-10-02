import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@utils/logger", () => ({ logger: {} }));
vi.mock("@middlewares/errorHandler.middleware", () => ({ AppError: class AppError extends Error { constructor(message: string, readonly statusCode: number, readonly isOperational: boolean, readonly code: string) { super(message); } } }));
import { sendWhatsAppTemplate } from "./whatsapp.service";
describe("template provider responses", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("returns a safe definite rejection without provider trace or values", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { code: 131008, message: "customer private value", fbtrace_id: "trace" } }), { status: 400 }));
    await expect(sendWhatsAppTemplate("+201000000000", "order", "en", [], "test-phone", "test-token")).rejects.toMatchObject({ code: "WHATSAPP_TEMPLATE_REJECTED", providerCode: 131008, retryable: false });
  });
  it("retains transport ambiguity instead of converting it into a definite rejection", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("fetch failed"); });
    await expect(sendWhatsAppTemplate("+201000000000", "order", "en", [], "test-phone", "test-token")).rejects.toBeInstanceOf(TypeError);
  });
});
