const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildSchema } = require("./generate-order-integration-assets");
test("generated references are standalone and share canonical source definitions", () => {
  const schema = buildSchema({ components: { schemas: { CanonicalOrderEvent: { type: "object", properties: { order: { $ref: "#/components/schemas/Order" } } }, Order: { type: "object", required: ["id"], properties: { id: { type: "string" } } } } } });
  assert.equal(schema.properties.order.$ref, "#/$defs/Order");
  assert.deepEqual(schema.$defs.Order.required, ["id"]);
});
