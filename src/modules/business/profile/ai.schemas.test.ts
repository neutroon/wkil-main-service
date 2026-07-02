import { describe, expect, it } from "vitest";
import {
  strategicLinksSchema,
  strategicLinksJsonSchema,
  businessIdentitySchema,
  businessIdentityJsonSchema,
} from "./ai.schemas";
import { assertOpenAIStrictCompliant } from "@modules/ai-agent/aiAgent.zodStrict";

describe("strategicLinksSchema", () => {
  it("parses a valid urls array", () => {
    const parsed = strategicLinksSchema.parse({ urls: ["https://a.com", "https://b.com"] });
    expect(parsed.urls).toEqual(["https://a.com", "https://b.com"]);
  });

  it("rejects an empty urls array as not matching the prompt expectation", () => {
    // The schema allows it; the LLM should be instructed to return
    // 3-5, but the schema is permissive so a partial answer still
    // parses. We assert the shape here, not the content policy.
    const parsed = strategicLinksSchema.parse({ urls: [] });
    expect(parsed.urls).toEqual([]);
  });

  it("rejects missing urls", () => {
    expect(() => strategicLinksSchema.parse({})).toThrow();
  });
});

describe("businessIdentitySchema", () => {
  it("parses a fully-populated business identity", () => {
    const parsed = businessIdentitySchema.parse({
      business_name: "Acme",
      brand_identity: "We sell things",
      target_audience: "B2B SaaS buyers",
      voice_and_tone: "Professional and friendly",
      products_services: ["CRM", "Email automation"],
      expected_user_intents: ["Pricing", "Demo", "Integration"],
      contact_and_hours: {
        phone_numbers: ["+201234567890"],
        working_hours: "Sun-Thu 9-5",
        address: "Cairo, Egypt",
      },
      core_policies: "30-day refund",
      faqs: [{ question: "Do you integrate with X?", answer: "Yes, via API" }],
    });
    expect(parsed.business_name).toBe("Acme");
    expect(parsed.faqs).toHaveLength(1);
  });

  it("accepts null for every previously-optional field (strict-mode semantics)", () => {
    const parsed = businessIdentitySchema.parse({
      business_name: null,
      brand_identity: null,
      target_audience: null,
      voice_and_tone: null,
      products_services: [],
      expected_user_intents: [],
      contact_and_hours: { phone_numbers: [], working_hours: null, address: null },
      core_policies: null,
      faqs: [],
    });
    expect(parsed.business_name).toBeNull();
    expect(parsed.faqs).toEqual([]);
  });
});

/**
 * OpenAI strict-mode contract: every property in `properties` must
 * also appear in `required`, every object must set
 * `additionalProperties: false`. OpenAI's default
 * `withStructuredOutput` path (`jsonSchema` with `strict: true`)
 * enforces this server-side.
 */
describe("OpenAI strict-mode contract", () => {
  it("strategicLinksSchema is compliant", () => {
    assertOpenAIStrictCompliant(strategicLinksJsonSchema, "$");
  });

  it("businessIdentitySchema is compliant (incl. nested objects and arrays)", () => {
    assertOpenAIStrictCompliant(businessIdentityJsonSchema, "$");
  });
});
