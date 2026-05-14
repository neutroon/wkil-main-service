import type { AiRoutingDecision } from "./aiEngine.utils";

export type AgentReplyType =
  | "NORMAL_REPLY"
  | "ASK_FOR_CORRECTION"
  | "CONFIRM_ACTION_SUCCESS"
  | "SAFE_ACTION_FAILURE"
  | "HANDOFF"
  | "RESOLVE";

export type ActionFailureClass =
  | "VALIDATION_ERROR"
  | "POLICY_REJECTED"
  | "TIMEOUT"
  | "SYSTEM_ERROR"
  | "PROVIDER_ERROR"
  | "UNKNOWN";

export type ReplyPolicy = {
  active: boolean;
  reason: string;
  allowedActions: AiRoutingDecision["action"][];
  allowedReplyTypes: AgentReplyType[];
  canConfirmActionSuccess: boolean;
  canHandoff: boolean;
  requiresCustomerCorrection: boolean;
  failureClass?: ActionFailureClass;
  customerSafeError?: string;
  correctionFields: Array<{
    field: string;
    reason?: string;
  }>;
};

type CompletedActionEnvelope = {
  success: boolean;
  verification?: string;
  actionType?: string;
  reason?: string;
  data?: unknown;
  error?: string;
};

export function buildCompletedActionReplyPolicy(params: {
  envelope: CompletedActionEnvelope;
  handoffEnabled: boolean;
}): ReplyPolicy | undefined {
  const { envelope } = params;
  if (envelope.success === true && envelope.verification === "verified") {
    if (String(envelope.actionType || "").toUpperCase().includes("MUTATION")) {
      return {
        active: true,
        reason: "verified_mutation_result",
        allowedActions: ["REPLY_AUTO", "RESOLVE_CONVERSATION"],
        allowedReplyTypes: ["CONFIRM_ACTION_SUCCESS", "NORMAL_REPLY", "RESOLVE"],
        canConfirmActionSuccess: true,
        canHandoff: false,
        requiresCustomerCorrection: false,
        correctionFields: [],
      };
    }
    return undefined;
  }

  const failureClass = classifyCompletedActionFailure(envelope);
  const customerSafeError =
    customerSafeActionError(envelope.error) || firstCustomerSafeErrorString(envelope.data);

  if (failureClass === "VALIDATION_ERROR" || failureClass === "POLICY_REJECTED") {
    return {
      active: true,
      reason: "correctable_action_failure",
      allowedActions: ["REPLY_AUTO"],
      allowedReplyTypes: ["ASK_FOR_CORRECTION"],
      canConfirmActionSuccess: false,
      canHandoff: false,
      requiresCustomerCorrection: true,
      failureClass,
      customerSafeError,
      correctionFields: inferCorrectionFields(envelope, customerSafeError),
    };
  }

  return {
    active: true,
    reason: "non_correctable_action_failure",
    allowedActions: params.handoffEnabled ? ["HANDOFF_TO_HUMAN"] : ["REPLY_AUTO"],
    allowedReplyTypes: params.handoffEnabled ? ["HANDOFF"] : ["SAFE_ACTION_FAILURE"],
    canConfirmActionSuccess: false,
    canHandoff: params.handoffEnabled,
    requiresCustomerCorrection: false,
    failureClass,
    customerSafeError,
    correctionFields: [],
  };
}

export function replyPolicyPromptBlock(policy: ReplyPolicy): string {
  return `<reply_policy>
${JSON.stringify(policy, null, 2)}

Rules:
1. Set replyType to one of allowedReplyTypes.
2. Set action to one of allowedActions.
3. If requiresCustomerCorrection is true, ask exactly one concise question for the corrected field.
4. If canConfirmActionSuccess is false, do not confirm that the external action succeeded.
5. If canHandoff is false, do not transfer to a human unless the latest customer message explicitly asks for a human or shows anger.
</reply_policy>`;
}

export function validateDecisionAgainstReplyPolicy(params: {
  decision: AiRoutingDecision;
  policy?: ReplyPolicy;
  customerAskedForHumanOrEscalated: boolean;
}): { ok: true } | { ok: false; reason: string } {
  const { decision, policy } = params;
  if (!policy?.active) return { ok: true };

  const replyType = decision.replyType || "NORMAL_REPLY";
  if (!policy.allowedReplyTypes.includes(replyType)) {
    return {
      ok: false,
      reason: `replyType ${replyType} is not allowed. Allowed reply types: ${policy.allowedReplyTypes.join(", ")}`,
    };
  }

  const handoffOverride =
    decision.action === "HANDOFF_TO_HUMAN" &&
    params.customerAskedForHumanOrEscalated;
  if (!policy.allowedActions.includes(decision.action) && !handoffOverride) {
    return {
      ok: false,
      reason: `action ${decision.action} is not allowed. Allowed actions: ${policy.allowedActions.join(", ")}`,
    };
  }

  if (
    decision.action === "HANDOFF_TO_HUMAN" &&
    !policy.canHandoff &&
    !handoffOverride
  ) {
    return { ok: false, reason: "handoff is not allowed by reply policy" };
  }

  if (
    !policy.canConfirmActionSuccess &&
    replyType === "CONFIRM_ACTION_SUCCESS"
  ) {
    return {
      ok: false,
      reason: "action success confirmation is not allowed by reply policy",
    };
  }

  if (
    policy.requiresCustomerCorrection &&
    replyType !== "ASK_FOR_CORRECTION"
  ) {
    return {
      ok: false,
      reason: "the reply must ask for corrected customer details",
    };
  }

  return { ok: true };
}

function classifyCompletedActionFailure(
  envelope: CompletedActionEnvelope,
): ActionFailureClass {
  const haystack = [
    envelope.reason,
    envelope.error,
    stringifySmall(envelope.data),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (haystack.includes("policy") || haystack.includes("unprovided")) {
    return "POLICY_REJECTED";
  }
  if (haystack.includes("timeout")) return "TIMEOUT";
  if (
    /validation|422|invalid|required|missing|parameter|field|country code|phone|corrected|رقم|موبايل|هاتف|ناقص|مطلوب|صحيح/.test(
      haystack,
    )
  ) {
    return "VALIDATION_ERROR";
  }
  if (/network|runtime|system|connection/.test(haystack)) return "SYSTEM_ERROR";
  if (haystack.trim()) return "PROVIDER_ERROR";
  return "UNKNOWN";
}

function inferCorrectionFields(
  envelope: CompletedActionEnvelope,
  customerSafeError?: string,
): ReplyPolicy["correctionFields"] {
  const unprovided = envelope.reason?.match(/unprovided_parameter:([A-Za-z0-9_.-]+)/)?.[1];
  if (unprovided) {
    return [{ field: unprovided, reason: envelope.reason }];
  }

  const text = `${customerSafeError || ""} ${stringifySmall(envelope.data)}`.toLowerCase();
  if (/phone|country code|موبايل|هاتف|رقم/.test(text)) {
    return [{ field: "phone", reason: customerSafeError }];
  }
  if (/name|اسم/.test(text)) {
    return [{ field: "name", reason: customerSafeError }];
  }

  return [{ field: "customer_details", reason: customerSafeError }];
}

function customerSafeActionError(error?: string): string | undefined {
  if (!error) return undefined;
  const trimmed = error.trim();
  if (!trimmed || /^External API returned status \d+$/i.test(trimmed)) {
    return undefined;
  }
  return trimmed.slice(0, 500);
}

function firstCustomerSafeErrorString(value: unknown): string | undefined {
  const safe = flattenErrorStrings(value).find((candidate) => {
    const text = candidate.trim();
    return (
      text.length > 0 &&
      !/^External API returned status \d+$/i.test(text) &&
      !/https?:\/\//i.test(text)
    );
  });
  return safe ? safe.slice(0, 500) : undefined;
}

function flattenErrorStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flattenErrorStrings);
  if (!value || typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  const priorityKeys = ["errors", "message", "detail", "details", "error", "reason"];
  const prioritized = priorityKeys.flatMap((key) =>
    Object.prototype.hasOwnProperty.call(record, key)
      ? flattenErrorStrings(record[key])
      : [],
  );
  const rest = Object.entries(record)
    .filter(([key]) => !priorityKeys.includes(key))
    .flatMap(([, nested]) => flattenErrorStrings(nested));
  return [...prioritized, ...rest];
}

function stringifySmall(value: unknown): string {
  try {
    return JSON.stringify(value ?? null).slice(0, 2_000);
  } catch {
    return String(value ?? "");
  }
}
