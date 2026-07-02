import { z } from "zod";
import { toJsonSchema } from "@langchain/core/utils/json_schema";

/**
 * OpenAI strict-mode compatible schema used by the customer memory
 * capture pipeline (`memory_capture` in the admin pipeline registry).
 *
 * The model is told to return `{}` when nothing useful is in scope, so
 * every field is nullable and present in `required` — that is the
 * OpenAI strict-mode contract (see `ai.schemas.ts` and
 * `aiAgent.zodStrict.ts` for the test).
 */
export const memoryExtractionSchema = z.object({
  profileUpdates: z
    .object({
      name: z.string().nullable(),
      phone: z.string().nullable(),
      email: z.string().nullable(),
    })
    .nullable(),
  fieldUpdates: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .nullable(),
  notes: z.string().nullable(),
});

export type MemoryExtractionResult = z.infer<typeof memoryExtractionSchema>;

export const memoryExtractionJsonSchema = toJsonSchema(memoryExtractionSchema);
