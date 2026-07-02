import { describe, expect, it } from "vitest";
import {
  getAiRoutingDecisionSchemaForChannel,
  getAiRoutingDecisionJsonSchemaForChannel,
} from "./agentDecision.schema";

const baseDecision = {
  action: "REPLY_AUTO",
  replyType: "NORMAL_REPLY",
  handoffCategory: null,
  reasoning: "ok",
  requiresGrounding: false,
  grounded: false,
  usedChunkTypes: [],
  missingInfo: null,
  attachment: null,
};

describe("getAiRoutingDecisionSchemaForChannel", () => {
  it("does not expose comment-only fields to direct chat channels", () => {
    const parsed = getAiRoutingDecisionSchemaForChannel("messenger").parse({
      ...baseDecision,
      content: "direct reply",
      publicContent: "public reply",
      privateContent: "private reply",
    });

    expect(parsed).toMatchObject({ content: "direct reply" });
    expect("publicContent" in parsed).toBe(false);
    expect("privateContent" in parsed).toBe(false);
  });

  it("keeps public/private fields for facebook comments", () => {
    const parsed = getAiRoutingDecisionSchemaForChannel("facebook_comment").parse({
      ...baseDecision,
      publicContent: "public reply",
      privateContent: "private reply",
      intent: "SALES_DM",
    });

    expect(parsed).toMatchObject({
      publicContent: "public reply",
      privateContent: "private reply",
      intent: "SALES_DM",
    });
    expect("content" in parsed).toBe(false);
  });
});

/**
 * OpenAI strict-mode contract:
 *   - `additionalProperties: false` on every object schema
 *   - every property in `properties` also appears in `required`
 *
 * The default `method` for `withStructuredOutput` on a modern OpenAI model
 * is `jsonSchema` with `strict: true`, which enforces both rules server-side
 * and rejects the request with 400 if either is violated. This test guards
 * the schema against future drift — a developer who adds `.optional()`
 * instead of `.nullable()` will see the regression here before it surfaces
 * in production.
 */
describe("getAiRoutingDecisionJsonSchemaForChannel (OpenAI strict-mode contract)", () => {
  function assertOpenAIStrictCompliant(
    node: unknown,
    path: string,
  ): void {
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;

    if (obj.type === "object" && obj.properties) {
      expect(
        obj.additionalProperties,
        `additionalProperties must be false at ${path}`,
      ).toBe(false);
      const required = Array.isArray(obj.required) ? obj.required : [];
      const propertyKeys = Object.keys(obj.properties as object);
      for (const key of propertyKeys) {
        expect(
          required,
          `${path}.required must include "${key}"`,
        ).toContain(key);
      }
    }

    if (obj.properties && typeof obj.properties === "object") {
      for (const [key, child] of Object.entries(obj.properties)) {
        assertOpenAIStrictCompliant(child, `${path}.properties.${key}`);
      }
    }
    if (obj.items) {
      assertOpenAIStrictCompliant(obj.items, `${path}.items`);
    }
    if (Array.isArray(obj.anyOf)) {
      for (let i = 0; i < obj.anyOf.length; i++) {
        assertOpenAIStrictCompliant(obj.anyOf[i], `${path}.anyOf[${i}]`);
      }
    }
    if (Array.isArray(obj.oneOf)) {
      for (let i = 0; i < obj.oneOf.length; i++) {
        assertOpenAIStrictCompliant(obj.oneOf[i], `${path}.oneOf[${i}]`);
      }
    }
  }

  it("direct-chat schema is OpenAI strict-mode compliant", () => {
    const jsonSchema = getAiRoutingDecisionJsonSchemaForChannel("messenger");
    assertOpenAIStrictCompliant(jsonSchema, "$");
  });

  it("facebook-comment schema is OpenAI strict-mode compliant", () => {
    const jsonSchema = getAiRoutingDecisionJsonSchemaForChannel(
      "facebook_comment",
    );
    assertOpenAIStrictCompliant(jsonSchema, "$");
  });
});
