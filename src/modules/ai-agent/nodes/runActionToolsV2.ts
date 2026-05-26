import type { AgentContent, AgentStateType } from "@modules/ai-agent/core/agentState";
import { logger } from "@utils/logger";
import {
  createBullMqJobId,
  enqueueIntegrationAction,
} from "@modules/meta/core/meta.queue";
import {
  getAgentActionSourceStatusMetadata,
} from "@modules/integrations/external/agentActionExecutor.service";
import {
  createIntegrationActionRun,
  markIntegrationActionRunFailed,
} from "@modules/integrations/external/integrationActionRun.service";
import { validateChatRequestedExternalAction } from "@modules/ai-agent/chat/externalToolEligibility";
import { updateAgentTurnStatus } from "@modules/ai-agent/core/agentTurn.service";
import type { AiRoutingDecision } from "@modules/ai-agent/core/aiEngine.utils";
import {
  replyPolicyPromptBlock,
  type ReplyPolicy,
} from "@modules/ai-agent/core/replyPolicy";
import { assertLatestConversationAiRun } from "@modules/ai-agent/chat/conversationRunGuard";

export async function runActionToolsV2Node(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const call = state.toolCalls[0];
  if (!call) return {};

  if (state.toolCalls.length > 1) {
    logger.warn("ai.v2.tool.multiple_calls_ignored", {
      businessProfileId: state.businessProfileId,
      agentTurnId: state.agentTurnId,
      toolNames: state.toolCalls.map((item) => item.name),
    });
  }

  const sourceId = parseIntegrationActionSourceId(call.name);
  if (!sourceId) {
    return {
      decision: buildToolFailureDecision("The requested action is not available."),
    };
  }

  if (!state.conversationId || !state.agentTurnId) {
    return {
      decision: buildToolFailureDecision(
        "This action needs an active conversation before it can run.",
      ),
    };
  }
  await assertLatestConversationAiRun(
    state.conversationRunId && state.latestUserMessageId
      ? {
          conversationId: state.conversationId,
          runId: state.conversationRunId,
          latestUserMessageId: state.latestUserMessageId,
          startedAt: "",
        }
      : undefined,
    "before_tool_queue",
  );

  const source = await getAgentActionSourceStatusMetadata(
    state.businessProfileId,
    sourceId,
  );
  if (!source || source.trigger !== "CHAT_REQUESTED") {
    return {
      decision: buildToolFailureDecision("The requested action is not active."),
    };
  }

  const args = normalizeArgs(call.args);
  const latestMessage = latestUserMessage(state.contents);
  const historyText = textHistory(state.contents);
  const validation = await validateChatRequestedExternalAction({
    source,
    latestUserMessage: latestMessage,
    args,
    historyText,
    customerPhone: state.customerPhone,
    conversationId: state.conversationId,
  });

  if (!validation.shouldQueue) {
    const replyPolicy = buildRejectedToolReplyPolicy(validation.reasoning);
    logger.warn("ai.v2.tool.policy_rejected", {
      businessProfileId: state.businessProfileId,
      conversationId: state.conversationId,
      agentTurnId: state.agentTurnId,
      sourceId,
      reason: validation.reasoning,
    });

    return {
      contents: appendFunctionResponse(state, call, {
        success: false,
        verification: "failed",
        actionType: call.name,
        reason: "action_policy_rejected",
        data: {
          queued: false,
          policyReason: validation.reasoning,
        },
      }),
      toolCalls: [],
      tools: undefined,
      replyPolicy,
      systemInstruction: `${state.systemInstruction}\n\n${replyPolicyPromptBlock(replyPolicy)}`,
      // This was rejected by deterministic policy before any external request ran.
      // Feed the tool response back to the model so it can ask one clarification,
      // but do not run the post-tool guardrail/recovery layer on top of it.
      hadToolExecution: false,
      decision: null,
    };
  }

  const stepKey =
    state.actionStepKey ||
    (String(source.actionType || "").toUpperCase() === "MUTATION"
      ? "mutation"
      : "lookup");
  const jobId = createBullMqJobId(
    "integration-action",
    state.agentTurnId,
    sourceId,
    stepKey,
  );
  const actionRun = await createIntegrationActionRun({
    businessProfileId: state.businessProfileId,
    sourceId,
    conversationId: state.conversationId,
    agentTurnId: state.agentTurnId,
    parentRunId: state.parentActionRunId ?? null,
    workflowId: state.activeWorkflowId ?? null,
    stepKey,
    trigger: "CHAT_REQUESTED",
    actionType: source.actionType ?? null,
    toolName: call.name,
    jobId,
    requestPayload: args,
  });

  try {
    await enqueueIntegrationAction(
      {
        businessProfileId: state.businessProfileId,
        trigger: "CHAT_REQUESTED",
        conversationId: state.conversationId,
        sourceId,
        actionRunId: actionRun.id,
        agentTurnId: state.agentTurnId,
        parentRunId: state.parentActionRunId ?? null,
        workflowId: state.activeWorkflowId ?? null,
        stepKey,
        toolName: call.name,
        args,
        customerPhone: state.customerPhone,
        latestUserText: latestMessage,
        historyText,
      },
      { jobId },
    );
  } catch (error: any) {
    await markIntegrationActionRunFailed({
      id: actionRun.id,
      reason: error?.message || "queue_failed",
    });
    throw error;
  }

  await updateAgentTurnStatus(state.agentTurnId, "WAITING_ACTION");

  return {
    hadToolExecution: true,
    queuedActionRunId: actionRun.id,
    decision: {
      action: "REPLY_AUTO",
      replyType: "NORMAL_REPLY",
      handoffCategory: null,
      reasoning: "Queued chat-requested action; waiting for background result.",
      content: "",
      publicContent: "",
      privateContent: "",
      requiresGrounding: false,
      grounded: true,
      usedChunkTypes: [],
      missingInfo: null,
      attachment: null,
      queuedActionRunId: actionRun.id,
      queuedActionSourceId: sourceId,
      agentTurnStatus: "WAITING_ACTION",
    },
  };
}

function buildRejectedToolReplyPolicy(reason: string): ReplyPolicy {
  const field =
    reason.match(/unprovided_parameter:([A-Za-z0-9_.-]+)/)?.[1] ||
    reason.match(/Missing required parameters:\s*([A-Za-z0-9_.-]+)/)?.[1];
  return {
    active: true,
    reason: "tool_policy_rejected",
    allowedActions: ["REPLY_AUTO"],
    allowedReplyTypes: ["ASK_FOR_CORRECTION"],
    canConfirmActionSuccess: false,
    canHandoff: false,
    requiresCustomerCorrection: true,
    failureClass: "POLICY_REJECTED",
    customerSafeError: field
      ? `Missing required field: ${field}`
      : "A required action parameter was not provided by an allowed source.",
    correctionFields: [
      {
        field: field || "required_details",
        reason,
      },
    ],
  };
}

function parseIntegrationActionSourceId(toolName: string): number | null {
  const match = toolName.match(/^integration_action_(\d+)$/);
  if (!match) return null;
  const sourceId = Number(match[1]);
  return Number.isInteger(sourceId) ? sourceId : null;
}

function normalizeArgs(args: unknown): Record<string, any> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  return args as Record<string, any>;
}

function latestUserMessage(contents: AgentContent[]): string {
  return (
    ([...contents].reverse().find((turn) => turn.role === "user")?.content || "")
      .trim()
  );
}

function textHistory(contents: AgentContent[]): string {
  return contents
    .map((turn) => turn.content || "")
    .filter(Boolean)
    .join("\n");
}

function appendFunctionResponse(
  state: AgentStateType,
  call: NonNullable<AgentStateType["toolCalls"][number]>,
  response: Record<string, unknown>,
): AgentContent[] {
  return [
    ...state.contents,
    {
      role: "tool" as const,
      content: JSON.stringify(response),
      toolCallId: call.id,
      toolName: call.name,
      toolResult: response,
    },
  ];
}

function buildToolFailureDecision(content: string): AiRoutingDecision {
  return {
    action: "HANDOFF_TO_HUMAN",
    replyType: "HANDOFF",
    handoffCategory: "SYSTEM_ERROR",
    reasoning: content,
    content: "",
    requiresGrounding: true,
    grounded: false,
    usedChunkTypes: [],
    missingInfo: content,
    agentTurnStatus: "FAILED",
  };
}
