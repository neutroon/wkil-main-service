import { z } from "zod";

const FIELD_TYPES = [
  "STRING",
  "NUMBER",
  "INTEGER",
  "BOOLEAN",
  "ARRAY",
  "OBJECT",
  "FIXED",
] as const;

const fieldTypeSchema = z
  .enum(FIELD_TYPES)
  .describe("Field type must be one of STRING, NUMBER, INTEGER, BOOLEAN, ARRAY, OBJECT, or FIXED.");

const fixedValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
  z.null(),
]);

export const aiFieldRuleSchema: z.ZodTypeAny = z.lazy(() =>
  z
    .object({
      type: fieldTypeSchema,
      description: z.string().min(1).optional(),
      required: z.boolean().optional(),
      value: fixedValueSchema.optional(),
      properties: z.record(z.string(), aiFieldRuleSchema).optional(),
      items: aiFieldRuleSchema.optional(),
    })
    .strict()
    .superRefine((rule, ctx) => {
      if (rule.type !== "FIXED" && !rule.description) {
        ctx.addIssue({
          code: "custom",
          path: ["description"],
          message: "description is required for dynamic fields",
        });
      }

      if (rule.type === "FIXED" && rule.value === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message: "value is required for FIXED fields",
        });
      }

      if (rule.type === "OBJECT" && !rule.properties) {
        ctx.addIssue({
          code: "custom",
          path: ["properties"],
          message: "properties is required for OBJECT fields",
        });
      }

      if (rule.type === "ARRAY" && !rule.items) {
        ctx.addIssue({
          code: "custom",
          path: ["items"],
          message: "items is required for ARRAY fields",
        });
      }
    }),
);

export const aiSchemaObject = z.record(z.string(), aiFieldRuleSchema);
