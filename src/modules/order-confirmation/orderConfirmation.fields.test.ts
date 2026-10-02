import { describe, expect, it } from "vitest";
import { listOrderTemplateFields, renderOrderTemplateField } from "./orderConfirmation.fields";
import { getBodyMappingEntries, validateOrderTemplateMapping } from "./orderConfirmation.template-mapping";

describe("order template fields", () => {
  it("renders a single-line full address with optional components", () => {
    expect(renderOrderTemplateField({ shippingAddress: { addressLine1: "Street 1\nApt 2", city: "Cairo", state: "Cairo", country: "Egypt" } }, "shippingFullAddress", "en").text).toBe("Street 1 Apt 2, Cairo, Egypt");
    expect(renderOrderTemplateField({ shippingAddress: { addressLine1: "Street 1", city: "Cairo" } }, "shippingFullAddress", "ar").text).toBe("Street 1، Cairo");
    expect(renderOrderTemplateField({ shippingAddress: { addressLine1: "Street Cairo", city: "Cairo" } }, "shippingFullAddress", "en").text).toBe("Street Cairo, Cairo");
  });
  it("requires a street rather than inferring it from a city", () => {
    expect(renderOrderTemplateField({ shippingAddress: { city: "Cairo" } }, "shippingFullAddress", "ar")).toEqual({ text: "", reason: "missing" });
    expect(renderOrderTemplateField({ shippingAddress: { addressLine1: "  " } }, "shippingFullAddress", "en").reason).toBe("blank");
  });
  it("reports missing, blank, and invalid values without customer data", () => {
    expect(renderOrderTemplateField({}, "shippingCountry", "en").reason).toBe("missing");
    expect(renderOrderTemplateField({ shippingAddress: { country: "  " } }, "shippingCountry", "en").reason).toBe("blank");
    expect(renderOrderTemplateField({ shippingAddress: { country: {} } }, "shippingCountry", "en").reason).toBe("invalid");
    expect(renderOrderTemplateField({ total: "0", currency: "EGP" }, "total", "en").text).toContain("0");
    expect(renderOrderTemplateField({}, "total", "en").reason).toBe("missing");
  });
  it("preserves exact quantities and present snapshot fields", () => {
    expect(renderOrderTemplateField({ lineItems: [{ quantity: "0.1" }, { quantity: "0.2" }] }, "quantity", "en").text).toBe("0.3");
    expect(renderOrderTemplateField({ customerName: "Mona" }, "customerName", "en").text).toBe("Mona");
    expect(renderOrderTemplateField({ orderNumber: "#42" }, "orderNumber", "en").text).toBe("#42");
    expect(renderOrderTemplateField({ items: [{ name: "A" }, { name: "B" }] }, "itemSummary", "en").text).toBe("A, B");
  });
  it("describes allowlisted canonical paths and preserves placeholder identities", () => {
    expect(listOrderTemplateFields().find(field => field.id === "shippingFullAddress")?.requiredPaths).toEqual(["order.shippingAddress.addressLine1"]);
    expect(getBodyMappingEntries({ body: { "5": "shippingCountry", "2": "shippingCity" } })).toEqual([{ placeholder: "2", field: "shippingCity" }, { placeholder: "5", field: "shippingCountry" }]);
    expect(getBodyMappingEntries(validateOrderTemplateMapping(["currency"]))).toEqual([{ placeholder: "1", field: "quantity" }]);
    expect(getBodyMappingEntries({ "3": "shippingFullAddress" })).toEqual([{ placeholder: "3", field: "shippingFullAddress" }]);
    expect(() => validateOrderTemplateMapping(["unknown"])).toThrow("Unknown body field");
  });
  it("handles malformed legacy items without throwing or inventing names", () => {
    const order = { items: [null, { name: "Test Item", quantity: "2" }, { name: {}, quantity: {} }] };
    expect(renderOrderTemplateField(order, "itemSummary", "en").text).toBe("Test Item");
    expect(renderOrderTemplateField(order, "quantity", "en").text).toBe("2");
  });
});
