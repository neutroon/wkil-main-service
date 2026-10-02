const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const root = path.resolve(__dirname, "..");

function buildSchema(openapi) {
  const definitions = {};
  function visit(value) {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    if (value.$ref) {
      const name = value.$ref.replace("#/components/schemas/", "");
      if (!openapi.components.schemas[name]) throw new Error(`Unknown schema ${name}`);
      if (!definitions[name]) { definitions[name] = {}; definitions[name] = visit(openapi.components.schemas[name]); }
      return { ...value, $ref: `#/$defs/${name}` };
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)]));
  }
  const schema = visit(openapi.components.schemas.CanonicalOrderEvent);
  return { $schema: "https://json-schema.org/draft/2020-12/schema", ...schema, $defs: definitions };
}
async function generate(check = false) {
  const openapiText = fs.readFileSync(path.join(root, "docs/openapi.yaml"), "utf8");
  const openapi = YAML.parse(openapiText);
  const schema = buildSchema(openapi);
  const guide = fs.readFileSync(path.join(root, "docs/integrations/generic-store.md"), "utf8");
  const { default: openapiTS, astToString } = await import("openapi-typescript");
  const exampleContract = { openapi: openapi.openapi, info: openapi.info, paths: {}, components: { schemas: Object.fromEntries(["CanonicalOrderEvent", ...Object.keys(schema.$defs)].map(name => [name, openapi.components.schemas[name]])) } };
  const example = `${astToString(await openapiTS(exampleContract))}\nexport type OrderEvent = components["schemas"]["CanonicalOrderEvent"];\n`;
  const source = `// Generated from docs/openapi.yaml and the integration guide. Do not edit.\nexport const ORDER_EVENT_JSON_SCHEMA = ${JSON.stringify(schema, null, 2)};\nexport const ORDER_INTEGRATION_GUIDE = ${JSON.stringify(guide)};\nexport const ORDER_EVENT_TYPESCRIPT_EXAMPLE = ${JSON.stringify(example)};\n`;
  const target = path.join(root, "src/modules/order-confirmation/orderConfirmation.integration-assets.generated.ts");
  if (check) {
    if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== source) throw new Error("Integration assets are stale; run npm run integration:assets");
  } else fs.writeFileSync(target, source);
}
module.exports = { buildSchema, generate };
if (require.main === module) generate(process.argv.includes("--check")).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
