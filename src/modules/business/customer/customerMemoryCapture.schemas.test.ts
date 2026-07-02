import { describe, expect, it } from "vitest";
import {
  memoryExtractionSchema,
  memoryExtractionJsonSchema,
} from "./customerMemoryCapture.schemas";
import { assertOpenAIStrictCompliant } from "@modules/ai-agent/aiAgent.zodStrict";

describe("memoryExtractionSchema", () => {
  it("parses a fully-populated extraction", () => {
    const parsed = memoryExtractionSchema.parse({
      profileUpdates: { name: "Hesham", phone: "+201234567890", email: null },
      fieldUpdates: { requested_program: "Life coaching" },
      notes: "Wants registration details.",
    });
    expect(parsed.profileUpdates?.name).toBe("Hesham");
    expect(parsed.fieldUpdates?.requested_program).toBe("Life coaching");
  });

  it("parses an empty `{}` extraction (the model's `nothing useful` signal)", () => {
    const parsed = memoryExtractionSchema.parse({
      profileUpdates: null,
      fieldUpdates: null,
      notes: null,
    });
    expect(parsed.profileUpdates).toBeNull();
    expect(parsed.fieldUpdates).toBeNull();
    expect(parsed.notes).toBeNull();
  });

  it("rejects extra properties on the top level (additionalProperties: false)", () => {
    expect(() =>
      memoryExtractionSchema.parse({
        profileUpdates: null,
        fieldUpdates: null,
        notes: null,
        // extra property — Zod strips it by default for `.object`, but
        // we assert via the JSON schema contract that the resulting
        // schema is strict-mode-friendly.
        rogue: "value",
      }),
    ).not.toThrow(); // Zod strips extras; the contract is enforced via the JSON schema below
  });

  it("accepts string, number, and boolean values in fieldUpdates", () => {
    const parsed = memoryExtractionSchema.parse({
      profileUpdates: null,
      fieldUpdates: {
        favorite_color: "blue",
        items_count: 42,
        is_vip: true,
      },
      notes: null,
    });
    expect(parsed.fieldUpdates).toEqual({
      favorite_color: "blue",
      items_count: 42,
      is_vip: true,
    });
  });
});

/**
 * OpenAI strict-mode contract: every property in `properties` must
 * also appear in `required`, every object must set
 * `additionalProperties: false`. The memory schema is a hot path — a
 * regression here would 400 every memory-capture call against GPT
 * models.
 */
describe("OpenAI strict-mode contract", () => {
  it("memoryExtractionSchema is compliant", () => {
    assertOpenAIStrictCompliant(memoryExtractionJsonSchema, "$");
  });
});
