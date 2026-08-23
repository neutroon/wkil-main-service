// Regression: tool schemas must serialize to JSON Schema without `exclusiveMinimum`,
// which the Gemini API rejects as an unknown field. See production error:
// [400 Bad Request] Invalid JSON payload received. Unknown name "exclusiveMinimum"
// at 'tools[0].function_declarations[3].parameters.properties[0].value': Cannot find field.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { getCustomerTool } from "./getCustomer.tool";
import { copilotTools } from "./index";

function findExclusiveMinimum(obj: unknown, path = ""): string[] {
  if (obj === null || typeof obj !== "object") return [];
  const found: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k === "exclusiveMinimum") found.push(path ? `${path}.${k}` : k);
    if (v !== null && typeof v === "object") {
      found.push(...findExclusiveMinimum(v, path ? `${path}.${k}` : k));
    }
  }
  return found;
}

// Minimal re-implementation of LangChain's zod-to-JSON-Schema conversion used by
// bindTools(). LangChain calls toJsonSchema / zod-to-json-schema internally;
// this returns the same shape for our test purposes.
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  // zod's built-in json serializer: emits the exact shape the LLM SDK receives.
  // (We don't import from langchain here to keep the test free of @langchain mocks.)
  const json = (schema as any).toJSONSchema?.() ?? (z as any).toJSONSchema?.(schema);
  if (!json) {
    throw new Error("zod-to-json-schema not available; install zod >=3.23");
  }
  return json;
}

describe("copilot tool schema compatibility", () => {
  it("every tool schema serializes without exclusiveMinimum (Gemini rejects it)", () => {
    for (const tool of copilotTools) {
      const json = zodToJsonSchema(tool.schema);
      const offending = findExclusiveMinimum(json);
      expect(offending, `tool ${tool.name} has exclusiveMinimum at: ${offending.join(", ")}`).toEqual([]);
    }
  });

  it("get_customer accepts only positive customerId (regression: was z.number().int().positive() which emits exclusiveMinimum)", () => {
    // The tool must still reject 0 and negative numbers — behavior preserved.
    const schema = getCustomerTool.schema as z.ZodTypeAny;
    expect(() => (schema as any).parse({ customerId: 1 })).not.toThrow();
    expect(() => (schema as any).parse({ customerId: 0 })).toThrow();
    expect(() => (schema as any).parse({ customerId: -1 })).toThrow();
  });
});