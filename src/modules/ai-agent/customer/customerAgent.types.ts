import { z } from "zod";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * The continuation is transient model context, not an audit/persistence
 * envelope. Keep this budget aligned with agent-svc/customer_schemas.py.
 * Compact UTF-8 JSON of the complete `context` value must fit in maxBytes.
 */
export const CUSTOMER_AGENT_CONTINUATION_LIMITS = Object.freeze({
  maxBytes: 16_384,
  maxActionTypeLength: 128,
  maxReasonLength: 256,
  maxErrorLength: 512,
  maxDataDepth: 5,
  maxObjectKeys: 32,
  maxArrayItems: 32,
  maxDataStringLength: 1_024,
  maxDataKeyLength: 128,
  truncationMarker: "[truncated]",
  truncationKey: "__truncated__",
});

type ContinuationLimits = typeof CUSTOMER_AGENT_CONTINUATION_LIMITS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertUnicodeString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      throw new Error("Continuation data contains an unpaired Unicode surrogate");
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error("Continuation data contains an unpaired Unicode surrogate");
    }
  }
}

function truncateUnicode(value: string, maxLength: number): string {
  assertUnicodeString(value);
  const marker = CUSTOMER_AGENT_CONTINUATION_LIMITS.truncationMarker;
  const codePoints = Array.from(value);
  if (codePoints.length <= maxLength) return value;
  if (maxLength <= marker.length) return marker.slice(0, maxLength);
  return `${codePoints.slice(0, maxLength - marker.length).join("")}${marker}`;
}

function compactJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function uniqueObjectKey(
  value: string,
  used: Set<string>,
  limits: ContinuationLimits,
  reserveTruncationKey: boolean,
): string {
  const base = truncateUnicode(value, limits.maxDataKeyLength);
  if (!used.has(base) && (!reserveTruncationKey || base !== limits.truncationKey)) {
    used.add(base);
    return base;
  }

  for (let suffixIndex = 1; ; suffixIndex += 1) {
    const suffix = `~${suffixIndex}`;
    const prefix = Array.from(base)
      .slice(0, Math.max(0, limits.maxDataKeyLength - Array.from(suffix).length))
      .join("");
    const candidate = `${prefix}${suffix}`;
    if (!used.has(candidate) && (!reserveTruncationKey || candidate !== limits.truncationKey)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function projectJsonValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  limits: ContinuationLimits,
): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return typeof value === "string"
      ? truncateUnicode(value, limits.maxDataStringLength)
      : value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Continuation data must contain JSON numbers");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error("Continuation data contains an unsafe JSON integer");
    }
    if (Object.is(value, -0)) return 0;
    return value;
  }

  if (typeof value !== "object") {
    throw new Error("Continuation data contains an unsupported non-JSON value");
  }
  if (seen.has(value)) throw new Error("Continuation data contains a cycle");
  if (!isPlainObject(value) && !Array.isArray(value)) {
    throw new Error("Continuation data contains an unsupported object");
  }
  if (depth >= limits.maxDataDepth) return limits.truncationMarker;

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const truncated = value.length > limits.maxArrayItems;
      const itemLimit = truncated ? limits.maxArrayItems - 1 : limits.maxArrayItems;
      const projected = value
        .slice(0, itemLimit)
        .map((item) => projectJsonValue(item, depth + 1, seen, limits));
      if (truncated) projected.push(limits.truncationMarker);
      return projected;
    }

    const keys = Object.keys(value);
    keys.forEach(assertUnicodeString);
    keys.sort((left, right) => {
      const leftCodePoints = Array.from(left).map((character) => character.codePointAt(0) ?? 0);
      const rightCodePoints = Array.from(right).map((character) => character.codePointAt(0) ?? 0);
      for (let index = 0; index < Math.min(leftCodePoints.length, rightCodePoints.length); index += 1) {
        const difference = leftCodePoints[index] - rightCodePoints[index];
        if (difference !== 0) return difference;
      }
      return leftCodePoints.length - rightCodePoints.length;
    });
    const truncated = keys.length > limits.maxObjectKeys;
    const keyLimit = truncated ? limits.maxObjectKeys - 1 : limits.maxObjectKeys;
    const projected: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    const usedKeys = new Set<string>();
    for (const key of keys.slice(0, keyLimit)) {
      const projectedKey = uniqueObjectKey(key, usedKeys, limits, truncated);
      projected[projectedKey] = projectJsonValue(
        value[key],
        depth + 1,
        seen,
        limits,
      );
    }
    if (truncated) {
      const markerKey = uniqueObjectKey(
        limits.truncationKey,
        usedKeys,
        limits,
        false,
      );
      projected[markerKey] = limits.truncationMarker;
    }
    return projected;
  } finally {
    seen.delete(value);
  }
}

function shrinkJsonValue(value: JsonValue, limits: ContinuationLimits): JsonValue {
  if (typeof value === "string") {
    if (value === limits.truncationMarker) return value;
    return truncateUnicode(value, Math.max(limits.truncationMarker.length, Math.floor(Array.from(value).length / 2)));
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [limits.truncationMarker];
    const itemLimit = Math.max(1, Math.ceil(value.length / 2));
    const output = value.slice(0, itemLimit).map((item) => shrinkJsonValue(item, limits));
    if (output.length < value.length || value[value.length - 1] !== limits.truncationMarker) {
      output[output.length - 1] = limits.truncationMarker;
    }
    return output;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((key) => key !== limits.truncationKey);
    if (keys.length === 0) return { [limits.truncationKey]: limits.truncationMarker };
    const keep = Math.max(1, Math.ceil(keys.length / 2));
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key of keys.slice(0, keep)) {
      output[key] = shrinkJsonValue(value[key], limits);
    }
    output[limits.truncationKey] = limits.truncationMarker;
    return output;
  }
  return limits.truncationMarker;
}

function fitDataToPromptBudget(
  envelope: {
    success: boolean;
    verification: "verified" | "failed";
    actionType: string;
    reason: string;
    data: JsonValue;
    error?: string;
  },
  limits: ContinuationLimits,
): typeof envelope {
  let candidate = envelope;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const context = { type: "external_action_result" as const, envelope: candidate };
    if (compactJsonBytes(context) <= limits.maxBytes) return candidate;
    candidate = { ...candidate, data: shrinkJsonValue(candidate.data, limits) };
  }
  return { ...candidate, data: limits.truncationMarker };
}

export const CUSTOMER_AGENT_DECISION_CONTRACT_VERSION = 1 as const;

const customerAttachmentRequestSchema = z.object({
  asset_name: z.string().trim().min(1).max(255),
  caption: z.string().trim().max(1000).nullable().optional(),
}).strict();

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
    attachment: customerAttachmentRequestSchema.nullable().optional(),
  })
  .strict()
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
    if (value.action !== "REPLY" && value.attachment) {
      ctx.addIssue({
        code: "custom",
        path: ["attachment"],
        message: "Only REPLY may request an attachment",
      });
    }
  });

export type CustomerAgentDecision = z.infer<typeof customerAgentDecisionSchema>;
export type CustomerChannel =
  | "web"
  | "messenger"
  | "whatsapp"
  | "facebook_comment";

export type CustomerAgentExternalActionEnvelope = {
  success: boolean;
  verification: "verified" | "failed";
  actionType: string;
  reason: string;
  data: JsonValue;
  error?: string;
};

/**
 * Unprojected backend input. The external executor owns the complete audit
 * envelope; the AgentClient is the single boundary that projects it into the
 * bounded model context above.
 */
export type CustomerAgentExternalActionEnvelopeInput = {
  success: boolean;
  verification: "verified" | "failed";
  actionType: string;
  reason: string;
  data: unknown;
  error?: string;
};

export type CustomerAgentContinuation = {
  type: "external_action_result";
  envelope: CustomerAgentExternalActionEnvelope;
};

export type CustomerAgentContinuationInput = {
  type: "external_action_result";
  envelope: CustomerAgentExternalActionEnvelopeInput;
};

const customerAgentContinuationInputSchema = z.object({
  type: z.literal("external_action_result"),
  envelope: z.object({
    success: z.boolean(),
    verification: z.enum(["verified", "failed"]),
    actionType: z.string(),
    reason: z.string(),
    data: z.unknown(),
    error: z.string().optional(),
  }).strict(),
}).strict();

function assertContinuationSemantics(value: {
  success: boolean;
  verification: "verified" | "failed";
  error?: string;
}): void {
  const expectedVerification = value.success ? "verified" : "failed";
  if (value.verification !== expectedVerification) {
    throw new Error("Continuation success must match its verification status");
  }
  if (value.error !== undefined && value.error.trim().length === 0) {
    throw new Error("Continuation error must not be blank");
  }
  if (value.success && value.error !== undefined) {
    throw new Error("Successful continuations cannot contain an error");
  }
}

export const customerAgentExternalActionEnvelopeSchema = z
  .object({
    success: z.boolean(),
    verification: z.enum(["verified", "failed"]),
    actionType: z.string().trim().min(1).max(CUSTOMER_AGENT_CONTINUATION_LIMITS.maxActionTypeLength),
    reason: z.string().trim().min(1).max(CUSTOMER_AGENT_CONTINUATION_LIMITS.maxReasonLength),
    data: z.json(),
    error: z.string().trim().min(1).max(CUSTOMER_AGENT_CONTINUATION_LIMITS.maxErrorLength).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expectedVerification = value.success ? "verified" : "failed";
    if (value.verification !== expectedVerification) {
      ctx.addIssue({
        code: "custom",
        path: ["verification"],
        message: "success must match verification",
      });
    }
    if (value.success && value.error !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: "Successful continuations cannot contain an error",
      });
    }
  });

export const customerAgentContinuationSchema = z
  .object({
    type: z.literal("external_action_result"),
    envelope: customerAgentExternalActionEnvelopeSchema,
  })
  .strict();

/**
 * Project the full backend envelope into a deterministic, JSON-only model
 * context. The full input remains available to backend persistence/audit; this
 * value is the only continuation accepted by Agent Server runs.create.
 */
export function projectCustomerAgentContinuation(value: unknown): CustomerAgentContinuation {
  const parsed = customerAgentContinuationInputSchema.parse(value);
  assertContinuationSemantics(parsed.envelope);
  assertUnicodeString(parsed.envelope.actionType);
  assertUnicodeString(parsed.envelope.reason);
  if (parsed.envelope.error !== undefined) assertUnicodeString(parsed.envelope.error);
  const limits = CUSTOMER_AGENT_CONTINUATION_LIMITS;
  const error = parsed.envelope.error?.trim();
  const envelope = fitDataToPromptBudget({
    success: parsed.envelope.success,
    verification: parsed.envelope.verification,
    actionType: truncateUnicode(parsed.envelope.actionType.trim(), limits.maxActionTypeLength),
    reason: truncateUnicode(parsed.envelope.reason.trim(), limits.maxReasonLength),
    data: projectJsonValue(parsed.envelope.data, 0, new WeakSet<object>(), limits),
    ...(error ? { error: truncateUnicode(error, limits.maxErrorLength) } : {}),
  }, limits);
  return customerAgentContinuationSchema.parse({
    type: parsed.type,
    envelope,
  }) as CustomerAgentContinuation;
}
