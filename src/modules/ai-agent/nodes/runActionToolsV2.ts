import type { AgentStateType, GeminiContent } from "@modules/ai-agent/core/agentState";
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

export async function runActionToolsV2Node(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const call = state.functionCalls[0];
  if (!call) return {};

  if (state.functionCalls.length > 1) {
    logger.warn("ai.v2.tool.multiple_calls_ignored", {
      businessProfileId: state.businessProfileId,
      agentTurnId: state.agentTurnId,
      toolNames: state.functionCalls.map((item) => item.name),
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
      functionCalls: [],
      tools: undefined,
      // This was rejected by deterministic policy before any external request ran.
      // Feed the function response back to Gemini so it can ask one clarification,
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

function latestUserMessage(contents: GeminiContent[]): string {
  return (
    [...contents]
      .reverse()
      .find((turn) => turn.role === "user")
      ?.parts.map((part) => part.text || "")
      .join("\n")
      .trim() || ""
  );
}

function textHistory(contents: GeminiContent[]): string {
  return contents
    .map((turn) =>
      turn.parts
        .map((part) => part.text || "")
        .filter(Boolean)
        .join("\n"),
    )
    .filter(Boolean)
    .join("\n");
}

function appendFunctionResponse(
  state: AgentStateType,
  call: NonNullable<AgentStateType["functionCalls"][number]>,
  response: Record<string, unknown>,
): GeminiContent[] {
  return [
    ...state.contents,
    {
      role: "user" as const,
      parts: [
        {
          functionResponse: {
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
            response,
          },
        },
      ],
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
