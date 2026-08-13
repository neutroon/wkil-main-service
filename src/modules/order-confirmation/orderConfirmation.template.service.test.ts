import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
}));

vi.mock("@config/prisma", () => ({
  default: {
    orderTemplateConfig: {
      findFirst: mocks.findFirst,
    },
  },
}));

import {
  renderOrderTemplateVariables,
  resolveActiveTemplateConfig,
  validateOrderTemplateMapping,
} from "./orderConfirmation.template.service";

const order = {
  orderNumber: "#100",
  customerName: "Mona",
  total: "12345678901234567890.123456",
  currency: "USD",
  locale: "en",
  lineItems: [{ name: "Product", quantity: "2" }],
  shippingAddress: { city: "Cairo", country: "EG" },
};

const mapping = {
  body: ["customerName", "total", "shippingCity"],
  buttons: ["confirmToken", "cancelToken"],
} as const;

describe("order confirmation template mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects body-only mappings and reversed action order", () => {
    expect(() => validateOrderTemplateMapping({ body: ["orderNumber"] })).toThrow(
      "Confirm and Cancel button parameters are required",
    );
    expect(() =>
      validateOrderTemplateMapping({
        body: ["orderNumber"],
        buttons: ["cancelToken", "confirmToken"],
      }),
    ).toThrow("Confirm and Cancel button parameters must be in order");
  });

  it("renders exact decimal text with the selected locale and mapped payloads", () => {
    const rendered = renderOrderTemplateVariables(
      order,
      mapping,
      { confirm: "raw-confirm", cancel: "raw-cancel" },
      "en-US",
    );

    expect(rendered.body[1]).toContain("12345678901234567890.123456");
    expect(rendered.buttons).toEqual({ confirm: "raw-confirm", cancel: "raw-cancel" });
    expect(rendered.previewText).toContain("Cairo");
  });

  it("scopes active approved templates to the integration business profile", async () => {
    mocks.findFirst.mockResolvedValue({
      id: 4,
      businessProfileId: 11,
      whatsappAccountId: 9,
      eventType: "order.created",
      locale: "ar",
      templateName: "order_confirm",
      languageCode: "ar",
      templateVersion: 2,
      isActive: true,
      approvalStatus: "APPROVED",
      variableMapping: mapping,
    });

    await resolveActiveTemplateConfig({
      integrationId: 7,
      businessProfileId: 11,
      whatsappAccountId: 9,
      locale: "ar",
      eventType: "order.created",
    });

    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          businessProfileId: 11,
          whatsappAccountId: 9,
          isActive: true,
          approvalStatus: "APPROVED",
        }),
      }),
    );
  });

  it("rejects a template snapshot returned for a different business profile", async () => {
    mocks.findFirst.mockResolvedValue({
      id: 4,
      businessProfileId: 99,
      whatsappAccountId: 9,
      eventType: "order.created",
      locale: "ar",
      templateName: "cross_tenant",
      languageCode: "ar",
      templateVersion: 1,
      isActive: true,
      approvalStatus: "APPROVED",
      variableMapping: mapping,
    });

    await expect(
      resolveActiveTemplateConfig({
        integrationId: 7,
        businessProfileId: 11,
        whatsappAccountId: 9,
        locale: "ar",
        eventType: "order.created",
      }),
    ).rejects.toThrow("another business profile");
  });
});
