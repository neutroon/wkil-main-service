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
      source: "fixed: Wkil AI",
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

  it("accepts explicit field source policies", () => {
    const result = aiSchemaObject.safeParse({
      orderId: {
        type: "STRING",
        source: "USER_PROVIDED",
        description: "Order ID provided by the customer",
        required: true,
      },
      requestDate: {
        type: "STRING",
        source: "AI_DERIVED",
        description: "ISO date derived from the customer's requested date",
      },
      phone: {
        type: "STRING",
        source: "CHAT_CONTEXT",
        contextKey: "customerPhone",
        description: "Phone number from the active channel context",
      },
      source: {
        type: "STRING",
        source: "DEFAULT",
        value: "Wkil AI",
        description: "Default source label sent if omitted by the user",
      },
    });

    expect(result.success).toBe(true);
  });

  it("requires server-side source policies to declare their value source", () => {
    expect(
      aiSchemaObject.safeParse({
        source: {
          type: "STRING",
          source: "DEFAULT",
          description: "Default source label",
        },
      }).success,
    ).toBe(false);

    expect(
      aiSchemaObject.safeParse({
        phone: {
          type: "STRING",
          source: "CHAT_CONTEXT",
          description: "Phone from chat context",
        },
      }).success,
    ).toBe(false);
  });
});

