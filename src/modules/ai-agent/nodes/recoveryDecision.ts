import { generateSafeRecoveryReply } from "@modules/ai-agent/chat/aiRecoveryReply";
import type { AgentStateType } from "@modules/ai-agent/core/agentState";

const CHAT_RESPONSE_DEADLINE_BUFFER_MS = 250;

type RecoveryDecisionParams = {
  action: "REPLY_AUTO" | "HANDOFF_TO_HUMAN";
  reasoning: string;
  failureReason: string;
  emergencyFallback: string;
  customerMessage?: string;
  handoffCategory?: string | null;
  allowHandoffLanguage?: boolean;
  requiresGrounding?: boolean;
  missingInfo?: string | null;
};

export function latestUserText(state: AgentStateType): string {
  const latest = [...state.contents].reverse().find((turn) => turn.role === "user");
  return latest?.content || "";
}

function recoveryContentFields(
  state: AgentStateType,
  recoveryReply: string,
): Pick<
  NonNullable<AgentStateType["decision"]>,
  "content" | "publicContent" | "privateContent" | "intent"
> {
  if (state.channel === "facebook_comment") {
    return {
      publicContent: recoveryReply,
      privateContent: "",
      intent: "NONE",
    };
  }

  return {
    content: recoveryReply,
  };
}

function remainingRecoveryBudgetMs(state: AgentStateType): number | undefined {
  if (!state.responseDeadlineAt) return undefined;
  return state.responseDeadlineAt - Date.now() - CHAT_RESPONSE_DEADLINE_BUFFER_MS;
}

export async function buildAiRecoveryDecision(
  state: AgentStateType,
  params: RecoveryDecisionParams,
): Promise<AgentStateType["decision"]> {
  const timeoutMs = remainingRecoveryBudgetMs(state);
  const recoveryReply =
    timeoutMs !== undefined && timeoutMs <= 0
      ? params.emergencyFallback
      : await generateSafeRecoveryReply({
          systemInstruction: state.systemInstruction,
          channel: state.channel,
          customerMessage: params.customerMessage ?? latestUserText(state),
          failureReason: params.failureReason,
          safeFallback: params.emergencyFallback,
          allowHandoffLanguage:
            params.allowHandoffLanguage ?? params.action === "HANDOFF_TO_HUMAN",
          timeoutMs,
        });

  return {
    action: params.action,
    replyType: params.action === "HANDOFF_TO_HUMAN" ? "HANDOFF" : "SAFE_ACTION_FAILURE",
    handoffCategory:
      params.action === "HANDOFF_TO_HUMAN"
        ? params.handoffCategory || "MISSING_KNOWLEDGE"
        : null,
    reasoning: params.reasoning,
    ...recoveryContentFields(state, recoveryReply),
    requiresGrounding: params.requiresGrounding ?? params.action === "HANDOFF_TO_HUMAN",
    grounded: false,
    usedChunkTypes: [],
    missingInfo:
      params.missingInfo === undefined
        ? params.action === "HANDOFF_TO_HUMAN"
          ? "The requested information could not be verified safely."
          : null
        : params.missingInfo,
    attachment: null,
  };
}

export function buildMissingKnowledgeDecision(
  state: AgentStateType,
  reasoning: string,
): Promise<AgentStateType["decision"]> {
  if (state.handoffEnabled === false) {
    return buildAiRecoveryDecision(state, {
      action: "REPLY_AUTO",
      handoffCategory: null,
      reasoning,
      failureReason: "missing_knowledge",
      emergencyFallback: state.policy.fallbackTemplates.unverified,
      allowHandoffLanguage: false,
      requiresGrounding: false,
      missingInfo: "The requested information could not be verified safely.",
    });
  }

  return buildAiRecoveryDecision(state, {
    action: "HANDOFF_TO_HUMAN",
    handoffCategory: "MISSING_KNOWLEDGE",
    reasoning,
    failureReason: "missing_knowledge",
    emergencyFallback: state.policy.fallbackTemplates.unverified,
    allowHandoffLanguage: true,
    requiresGrounding: true,
  });
}

export function buildSystemRecoveryDecision(
  state: AgentStateType,
  params: { reasoning: string; failureReason: string; handoffCategory?: string },
): Promise<AgentStateType["decision"]> {
  return buildAiRecoveryDecision(state, {
    action: "HANDOFF_TO_HUMAN",
    handoffCategory: params.handoffCategory || "SYSTEM_ERROR",
    reasoning: params.reasoning,
    failureReason: params.failureReason,
    emergencyFallback: state.policy.fallbackTemplates.failed,
    allowHandoffLanguage: true,
    requiresGrounding: false,
    missingInfo: null,
  });
}

export function buildImmediateSystemRecoveryDecision(
  state: AgentStateType,
  params: { reasoning: string; handoffCategory?: string },
): AgentStateType["decision"] {
  return {
    action: "HANDOFF_TO_HUMAN",
    replyType: "HANDOFF",
    handoffCategory: params.handoffCategory || "SYSTEM_TIMEOUT",
    reasoning: params.reasoning,
    ...recoveryContentFields(state, state.policy.fallbackTemplates.failed),
    requiresGrounding: false,
    grounded: false,
    usedChunkTypes: [],
    missingInfo: null,
    attachment: null,
  };
}
