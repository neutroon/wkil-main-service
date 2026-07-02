import { z } from "zod";
import { toJsonSchema } from "@langchain/core/utils/json_schema";

/**
 * OpenAI strict-mode compatible schemas used by the business profile AI
 * pipeline (`business_analysis` in the admin pipeline registry).
 *
 * The contract is the same as `agentDecision.schema.ts`:
 *   - Every property in `properties` must also appear in `required`.
 *   - Every object must have `additionalProperties: false` (Zod v4's
 *     `toJSONSchema` adds this automatically for `z.object`).
 *   - Use `.nullable()` for "may be absent" semantics — that keeps the
 *     field in `required` while letting the model return `null`.
 *   - Do NOT use `.optional()` here; that would omit the field from
 *     `required` and OpenAI's strict `response_format` would 400.
 *
 * The `assertOpenAIStrictCompliant` helper in
 * `aiAgent.zodStrict.ts` documents the test contract and is asserted
 * for every schema in this file by `ai.schemas.test.ts`.
 */
export const strategicLinksSchema = z.object({
  urls: z.array(z.string()),
});

export type StrategicLinksResult = z.infer<typeof strategicLinksSchema>;

export const businessIdentitySchema = z.object({
  business_name: z.string().nullable(),
  brand_identity: z.string().nullable(),
  target_audience: z.string().nullable(),
  voice_and_tone: z.string().nullable(),
  products_services: z.array(z.string()),
  expected_user_intents: z.array(z.string()),
  contact_and_hours: z.object({
    phone_numbers: z.array(z.string()),
    working_hours: z.string().nullable(),
    address: z.string().nullable(),
  }),
  core_policies: z.string().nullable(),
  faqs: z.array(
    z.object({
      question: z.string(),
      answer: z.string(),
    }),
  ),
});

export type BusinessIdentityResult = z.infer<typeof businessIdentitySchema>;

// JSON Schema view of the same Zod definitions, computed via the same
// `toJsonSchema` helper LangChain uses internally when building the
// OpenAI `response_format` payload. The strict-mode contract test
// asserts against this exact output.
export const strategicLinksJsonSchema = toJsonSchema(strategicLinksSchema);
export const businessIdentityJsonSchema = toJsonSchema(businessIdentitySchema);
