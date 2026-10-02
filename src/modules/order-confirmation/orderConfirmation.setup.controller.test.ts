import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { computeOrderWebhookSignature } from "./orderConfirmation.crypto";
const mocks = vi.hoisted(() => ({ integration: vi.fn(), template: vi.fn(), permit: vi.fn(), writes: vi.fn() }));
vi.mock("./orderConfirmation.repository", () => ({ findOrderIntegrationForSetup: mocks.integration, findOrderTemplateConfigForTest: mocks.template, insertOrderEventIfNew: mocks.writes }));
vi.mock("./orderConfirmation.setup-rateLimit", () => ({ acquireOrderSetupPermit: mocks.permit }));
vi.mock("@modules/auth/core/tokenCrypto", () => ({ decryptFacebookSecret: (secret: string) => secret }));
vi.mock("@config/prisma", () => ({ default: {} }));
import { getSignedOrderRequirements, validateSignedOrderEvent } from "./orderConfirmation.setup.controller";
const app = express();
app.use(express.raw({ type: "application/json", limit: "256kb" }));
app.post("/:integrationKey/requirements", getSignedOrderRequirements);
app.post("/:integrationKey/validate", validateSignedOrderEvent);
const event = { schemaVersion: "1", eventId: "test-1", eventType: "order.created", occurredAt: "2026-10-02T00:00:00Z", order: { id: "1", number: "1", total: "1", currency: "EGP", customer: { phone: "+201000000000" } } };
function signed(path: string, body: unknown, secret = "test-secret") {
  const raw = JSON.stringify(body), timestamp = String(Math.floor(Date.now() / 1000));
  return request(app).post(`/key/${path}`).set("Content-Type", "application/json").set("X-WKIL-Timestamp", timestamp).set("X-WKIL-Signature", computeOrderWebhookSignature(timestamp, Buffer.from(raw), secret)).set("Idempotency-Key", "test-1").send(raw);
}
describe("signed setup endpoints", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.permit.mockResolvedValue(null);
    mocks.integration.mockResolvedValue({ id: 2, businessProfileId: 11, whatsappAccountId: 9, defaultLocale: "en", signingSecret: "test-secret", previousSigningSecret: "previous-secret", isActive: false });
    mocks.template.mockResolvedValue({ id: 4, businessProfileId: 11, whatsappAccountId: 9, eventType: "order.created", locale: "en", templateName: "order", languageCode: "en", templateVersion: 1, isActive: true, approvalStatus: "APPROVED", variableMapping: ["shippingCountry"] });
  });
  it("permits authenticated inactive setup and returns missing paths without writes", async () => {
    expect((await signed("requirements", { schemaVersion: "1" })).status).toBe(200);
    const result = await signed("validate", event);
    expect(result.status).toBe(422);
    expect(result.body.errors[0]).toMatchObject({ field: "shippingCountry", paths: ["order.shippingAddress.country"] });
    expect(mocks.writes).not.toHaveBeenCalled();
    expect(JSON.stringify(result.body)).not.toContain("test-secret");
  });
  it("accepts a rotated previous secret but rejects invalid authentication", async () => {
    expect((await signed("requirements", { schemaVersion: "1" }, "previous-secret")).status).toBe(200);
    expect((await signed("validate", event, "wrong-secret")).status).toBe(401);
    expect(mocks.writes).not.toHaveBeenCalled();
  });
  it("rejects mismatched idempotency, unknown integrations and bad requirements", async () => {
    expect((await signed("validate", { ...event, eventId: "other" })).status).toBe(400);
    expect((await signed("requirements", { schemaVersion: "2" })).status).toBe(400);
    mocks.integration.mockResolvedValue(null);
    expect((await signed("requirements", { schemaVersion: "1" })).status).toBe(404);
  });
  it("fails closed for rate limiting and infrastructure failure", async () => {
    mocks.permit.mockResolvedValue(5000);
    const limited = await signed("requirements", { schemaVersion: "1" });
    expect(limited.status).toBe(429); expect(limited.headers["retry-after"]).toBe("5");
    mocks.permit.mockRejectedValue(new Error("private database address"));
    const failure = await signed("requirements", { schemaVersion: "1" });
    expect(failure.status).toBe(503); expect(JSON.stringify(failure.body)).not.toContain("private database");
  });
  it("authenticates exact bytes before parsing, rejects old timestamps, and bounds bodies", async () => {
    const raw = "{invalid-json", timestamp=String(Math.floor(Date.now()/1000));
    const sendRaw=(body:string,stamp:string,signature:string)=>request(app).post('/key/requirements').set('Content-Type','application/json').set('X-WKIL-Timestamp',stamp).set('X-WKIL-Signature',signature).send(body);
    expect((await sendRaw(raw,timestamp,computeOrderWebhookSignature(timestamp,Buffer.from(raw),'test-secret'))).status).toBe(400);
    const old=String(Number(timestamp)-301), body=JSON.stringify({schemaVersion:'1'});
    expect((await sendRaw(body,old,computeOrderWebhookSignature(old,Buffer.from(body),'test-secret'))).status).toBe(401);
    expect((await sendRaw(body+' ',timestamp,computeOrderWebhookSignature(timestamp,Buffer.from(body),'test-secret'))).status).toBe(401);
    expect((await sendRaw(' '.repeat(256*1024+1),timestamp,'v1='+'0'.repeat(64))).status).toBe(413);
    expect(mocks.writes).not.toHaveBeenCalled();
  });
});
