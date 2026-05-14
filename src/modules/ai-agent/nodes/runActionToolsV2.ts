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
import { generatePendingLookupStatusDecision } from "@modules/ai-agent/chat/pendingLookupStatus";
import { updateAgentTurnStatus } from "@modules/ai-agent/core/agentTurn.service";
import type { AiRoutingDecision } from "@modules/ai-agent/core/aiEngine.utils";
import { buildAiRecoveryDecision } from "./recoveryDecision";

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
      decision: await buildAiRecoveryDecision(state, {
        action: "REPLY_AUTO",
        handoffCategory: null,
        reasoning: `Action rejected by field-source policy: ${validation.reasoning}`,
        failureReason: validation.reasoning,
        emergencyFallback:
          state.policy?.fallbackTemplates?.unverified ||
          "I cannot confirm that from the available information.",
        allowHandoffLanguage: false,
        requiresGrounding: false,
        missingInfo: validation.reasoning,
      }),
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

  const pendingDecision = await generatePendingLookupStatusDecision({
    businessName: state.businessName || "the business",
    voice: state.businessVoice,
    tone: state.businessTone,
    channel: state.channel,
    latestUserText: latestMessage,
    recentTurns: recentTextTurns(state.contents, 3),
    source,
  });

  return {
    hadToolExecution: true,
    queuedActionRunId: actionRun.id,
    decision: {
      ...pendingDecision,
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

function recentTextTurns(contents: GeminiContent[], count: number) {
  return contents
    .map((turn) => ({
      role: turn.role,
      text: turn.parts
        .map((part) => part.text || "")
        .filter(Boolean)
        .join("\n"),
    }))
    .filter((turn) => turn.text.trim().length > 0)
    .slice(-count);
}

function buildToolFailureDecision(content: string): AiRoutingDecision {
  return {
    action: "HANDOFF_TO_HUMAN",
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
