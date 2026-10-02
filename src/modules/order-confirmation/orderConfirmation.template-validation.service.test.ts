import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock("@config/prisma", () => ({ default: { orderTemplateConfig: { findFirst: mocks.findFirst } } }));
vi.mock("./orderConfirmation.repository", () => ({ findOrderTemplateConfigForTest: mocks.findFirst }));
import { getOrderTemplateRequirements, inspectOrderTemplateVariables, validateOrderEventForTemplate } from "./orderConfirmation.template-validation.service";
const context = { integrationId: 7, businessProfileId: 11, whatsappAccountId: 9, defaultLocale: "en" as const };
const config = { id: 4, businessProfileId: 11, whatsappAccountId: 9, eventType: "order.created", locale: "en", templateName: "order", languageCode: "en", templateVersion: 1, isActive: true, approvalStatus: "APPROVED", variableMapping: { body: { "5": "shippingCountry" } } };
const event = { schemaVersion: "1", eventId: "synthetic-1", eventType: "order.created", occurredAt: "2026-10-02T00:00:00Z", order: { id: "1", number: "1", total: "0", currency: "EGP", customer: { phone: "+201000000000" }, shippingAddress: { addressLine1: "Street 1" } } };
describe("shared template readiness", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.findFirst.mockResolvedValue(config); });
  it("identifies a missing country by configured placeholder and canonical path", async () => {
    const result = await validateOrderEventForTemplate(event, context);
    expect(result).toMatchObject({ status: 422, body: { code: "TEMPLATE_DATA_INCOMPLETE", retryable: false, errors: [{ placeholder: "5", field: "shippingCountry", paths: ["order.shippingAddress.country"], reason: "missing" }] } });
  });
  it("returns schema paths without echoing invalid personal values", async () => {
    const result = await validateOrderEventForTemplate({ ...event, order: { ...event.order, customer: { phone: "private invalid phone" } } }, context);
    expect(result).toMatchObject({ status: 400, body: { code: "INVALID_ORDER_EVENT", errors: [{ paths: ["order.customer.phone"] }] } });
    expect(JSON.stringify(result)).not.toContain("private invalid phone");
  });
  it("re-resolves configuration each time and reports the actual fallback locale", async () => {
    mocks.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...config, variableMapping: { body: ["shippingFullAddress"] } });
    const result = await validateOrderEventForTemplate(event, context, { locale: "ar" });
    expect(result).toMatchObject({ status: 200, body: { data: { locale: "en", body: ["Street 1"], templateReady: true } } });
    mocks.findFirst.mockResolvedValue({ ...config, variableMapping: { body: ["shippingCity"] } });
    expect((await validateOrderEventForTemplate(event, context)).status).toBe(422);
  });
  it("does not confuse requirements with inspected presence", async () => {
    const result = await getOrderTemplateRequirements(context);
    expect(result.template.variables).toEqual([{ component: "body", placeholder: "5", field: "shippingCountry", paths: ["order.shippingAddress.country"] }]);
  });
  it("blocks cross-account templates and missing account configuration", async () => {
    mocks.findFirst.mockResolvedValue({ ...config, whatsappAccountId: 99 });
    expect((await validateOrderEventForTemplate(event, context)).status).toBe(409);
    expect(await validateOrderEventForTemplate(event, { ...context, whatsappAccountId: null })).toMatchObject({ status: 409, body: { code: "WHATSAPP_ACCOUNT_NOT_CONFIGURED" } });
  });
  it("permits static templates and rejects city-only full addresses", () => {
    expect(inspectOrderTemplateVariables({}, { body: [] }, "en").errors).toEqual([]);
    expect(inspectOrderTemplateVariables({ shippingAddress: { city: "Cairo" } }, ["shippingFullAddress"], "en").errors[0].reason).toBe("missing");
  });
});
