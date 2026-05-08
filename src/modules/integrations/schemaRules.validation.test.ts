import { describe, expect, it } from "vitest";
import { aiSchemaObject } from "./schemaRules.validation";

describe("aiSchemaObject", () => {
  it("accepts the standardized field rule format", () => {
    const result = aiSchemaObject.safeParse({
      customerName: {
        type: "STRING",
        description: "Customer full name",
        required: true,
      },
      priority: {
        type: "FIXED",
        value: 3,
        description: "Static CRM priority",
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects legacy shorthand fields", () => {
    const result = aiSchemaObject.safeParse({
      customerName: "Customer full name",
      source: "fixed: PagesPilot AI",
    });

    expect(result.success).toBe(false);
  });

  it("rejects unknown field types instead of silently falling back", () => {
    const result = aiSchemaObject.safeParse({
      budget: {
        type: "NUm",
        description: "Budget",
      },
    });

    expect(result.success).toBe(false);
  });
});
