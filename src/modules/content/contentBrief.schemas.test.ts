import { describe, expect, it } from "vitest";
import {
  competitorDiscoverySchema,
  competitorDiscoveryJsonSchema,
} from "./contentBrief.schemas";
import { assertOpenAIStrictCompliant } from "@modules/ai-agent/aiAgent.zodStrict";

describe("competitorDiscoverySchema", () => {
  it("parses a typical competitor list", () => {
    const parsed = competitorDiscoverySchema.parse({
      competitors: [
        { name: "Acme Co", url: "https://acme.com", reason: "Direct CRM competitor" },
        { name: "Beta Inc", url: "https://beta.io", reason: "Alternative for SMBs" },
      ],
    });
    expect(parsed.competitors).toHaveLength(2);
    expect(parsed.competitors[0].name).toBe("Acme Co");
  });

  it("parses an empty list (model found no competitors)", () => {
    const parsed = competitorDiscoverySchema.parse({ competitors: [] });
    expect(parsed.competitors).toEqual([]);
  });
});

/**
 * OpenAI strict-mode contract: every property in `properties` must
 * also appear in `required`, every object must set
 * `additionalProperties: false`.
 */
describe("OpenAI strict-mode contract", () => {
  it("competitorDiscoverySchema is compliant", () => {
    assertOpenAIStrictCompliant(competitorDiscoveryJsonSchema, "$");
  });
});
