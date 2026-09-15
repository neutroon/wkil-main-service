import { z } from "zod";

export const customerAgentDecisionSchema = z
  .object({
    action: z.enum(["REPLY", "HANDOFF", "RESOLVE", "NO_REPLY"]),
    content: z.string().trim().min(1).max(4000).nullable().optional(),
    reason_code: z.enum([
      "KNOWLEDGE_MATCH",
      "HUMAN_ACTION_REQUIRED",
      "INSUFFICIENT_KNOWLEDGE",
      "CUSTOMER_CLOSED",
      "POLICY_SUPPRESSED",
      "QUOTA_EXCEEDED",
    ]),
    handoff_category: z
      .enum(["SALES", "SUPPORT", "COMPLAINT", "OTHER"])
      .nullable()
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === "REPLY" && !value.content) {
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message: "REPLY requires content",
      });
    }
    if (value.action !== "REPLY" && value.content) {
      ctx.addIssue({
        code: "custom",
        path: ["content"],
        message: "Only REPLY may contain content",
      });
    }
  });

export type CustomerAgentDecision = z.infer<typeof customerAgentDecisionSchema>;
export type CustomerChannel =
  | "web"
  | "messenger"
  | "whatsapp"
  | "facebook_comment";
