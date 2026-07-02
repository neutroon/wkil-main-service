import { expect } from "vitest";

/**
 * Test helpers for the OpenAI strict-mode contract that every Zod
 * schema passed to `invokePipelineStructured` must satisfy.
 *
 * The contract is:
 *   - Every property in `properties` must also appear in `required`.
 *   - Every object schema must set `additionalProperties: false`.
 *
 * OpenAI's `response_format: { type: "json_schema", strict: true }` —
 * the default `method` for `withStructuredOutput` on any modern OpenAI
 * model — enforces both rules server-side and rejects the request with
 * 400 if either is violated. Every schema that goes through
 * `invokePipelineStructured` should have a corresponding test that
 * imports `assertOpenAIStrictCompliant` so a future developer adding
 * `.optional()` instead of `.nullable()` will see the regression here
 * before it surfaces in production.
 */
export function assertOpenAIStrictCompliant(node: unknown, path = "$"): void {
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;

  if (obj.type === "object" && obj.properties) {
    expect(
      obj.additionalProperties,
      `${path}.additionalProperties must be false`,
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
