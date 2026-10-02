import { describe, expect, it } from "vitest";
import Ajv from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { ORDER_EVENT_JSON_SCHEMA } from "./orderConfirmation.integration-assets.generated";
import { canonicalOrderEventSchema } from "./orderConfirmation.validation";
import { listOrderTemplateFields } from "./orderConfirmation.fields";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
const event = { schemaVersion: "1", eventId: "synthetic-contract", eventType: "order.created", occurredAt: "2026-10-02T00:00:00Z", order: { id: "1", number: "1", currency: "EGP", total: "0.1", customer: { phone: "+201000000000" } } };
describe("downloaded canonical contract", () => {
  const ajv = new Ajv({ strict: false }); addFormats(ajv);
  it("agrees with the canonical runtime boundary on synthetic valid and invalid inputs", () => {
    const validate = ajv.compile(ORDER_EVENT_JSON_SCHEMA);
    for (const input of [event, { ...event, schemaVersion: "2" }, { ...event, unknown: true }, { ...event, eventId: " " }, { ...event, order: { ...event.order, shippingAddress: { country: " " } } }, { ...event, order: { ...event.order, currency: "ZZZ" } }, { ...event, order: { ...event.order, total: 1 } }]) {
      expect(validate(input)).toBe(canonicalOrderEventSchema.safeParse(input).success);
    }
  });
  it("publishes the registry field IDs through OpenAPI", () => {
    const openapi = parse(readFileSync("docs/openapi.yaml", "utf8"));
    expect(openapi.components.schemas.OrderTemplateField.enum).toEqual(listOrderTemplateFields().map(field => field.id));
  });
});
