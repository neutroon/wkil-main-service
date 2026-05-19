import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentState, makeEmptyEvidence } from "./agentState";
import { callModelNode } from "../nodes/callModel";
import { runActionToolsV2Node } from "../nodes/runActionToolsV2";
import { parseDecisionNode } from "../nodes/parseDecision";
import { runGuardrailNode } from "../nodes/runGuardrail";
import { recordUsageNode } from "../nodes/recordUsage";
import { checkpointer } from "./checkpointer";
import { DEFAULT_AI_TRUTHFULNESS_POLICY } from "./aiEngine.utils";
import { assertQuotaAvailable } from "@modules/billing/billing.service";
import { logger } from "@utils/logger";
import prisma from "@config/prisma";
import type { AgentContent, AgentToolDefinition } from "./agentState";
import type { AiRoutingDecision, AiTruthfulnessPolicy } from "./aiEngine.utils";
import type { ReplyPolicy } from "./replyPolicy";

const workflowV2 = new StateGraph(AgentState)
  .addNode("callModel", callModelNode)
  .addNode("runActionTool", runActionToolsV2Node)
  .addNode("parseDecision", parseDecisionNode)
  .addNode("runGuardrail", runGuardrailNode)
  .addNode("recordUsage", recordUsageNode);

workflowV2.addEdge(START, "callModel");

workflowV2.addConditionalEdges("callModel", (state) => {
  if (state.decision !== null) return "recordUsage";
  if (state.toolCalls.length > 0) return "runActionTool";
  return "parseDecision";
});

workflowV2.addConditionalEdges("runActionTool", (state) => {
  if (state.decision !== null) return "recordUsage";
  return "callModel";
});

workflowV2.addConditionalEdges("parseDecision", (state) => {
  if (state.decision === null) return "callModel";
  if (state.hadToolExecution) return "runGuardrail";
  return "recordUsage";
});

workflowV2.addEdge("runGuardrail", "recordUsage");
workflowV2.addEdge("recordUsage", END);

export const agentGraphV2 = workflowV2.compile({ checkpointer });

export interface AgentGraphV2Params {
  agentTurnId: number;
  systemInstruction: string;
  historyTurns: { role: "user" | "model"; text?: string; parts?: any[] }[];
  customerMessage: string;
  tools?: AgentToolDefinition[];
  businessProfileId: number;
  businessName?: string;
  businessVoice?: string;
  businessTone?: string;
  customerPhone?: string;
  channel?: "messenger" | "whatsapp" | "web" | "facebook_comment";
  contextQuality?: "specific_evidence_found" | "core_context_only" | "no_context";
  availableChunkTypes?: string[];
  externalSourceFailureBehaviors?: Record<number, string>;
  policy?: Partial<AiTruthfulnessPolicy>;
  handoffEnabled?: boolean;
  conversationId?: number;
  activeWorkflowId?: number | null;
  parentActionRunId?: number | null;
  actionStepKey?: string | null;
  replyPolicy?: ReplyPolicy;
}

export async function runAgentGraphV2(
  params: AgentGraphV2Params,
): Promise<AiRoutingDecision> {
  try {
    return await _runGraphV2(params);
  } catch (graphError: any) {
    logger.error("ai.graph_v2.critical_failure", {
      error: graphError.message,
      businessProfileId: params.businessProfileId,
      agentTurnId: params.agentTurnId,
    });
    return {
      action: "HANDOFF_TO_HUMAN",
      replyType: "HANDOFF",
      handoffCategory: "SYSTEM_ERROR",
      reasoning: `Critical Graph V2 Failure: ${graphError.message}`,
      content: "",
      agentTurnStatus: "FAILED",
    };
  }
}

async function _runGraphV2(params: AgentGraphV2Params): Promise<AiRoutingDecision> {
  const profile = await prisma.businessProfile.findUnique({
    where: { id: params.businessProfileId },
    select: { userId: true },
  });
  if (!profile) throw new Error("Business profile not found");

  await assertQuotaAvailable(profile.userId, params.businessProfileId);

  const policy = {
    ...DEFAULT_AI_TRUTHFULNESS_POLICY,
    ...(params.policy ?? {}),
    fallbackTemplates: {
      ...DEFAULT_AI_TRUTHFULNESS_POLICY.fallbackTemplates,
      ...(params.policy?.fallbackTemplates ?? {}),
    },
  };

  const historyContents: AgentContent[] = params.historyTurns.map((turn) => ({
    role: turn.role,
    content: turn.text ?? textFromLegacyParts(turn.parts),
  }));

  try {
    await checkpointer.setup();
  } catch (error: any) {
    logger.warn("ai.graph_v2.checkpointer_setup_failed", {
      error: error?.message || String(error),
    });
  }

  const finalState = await agentGraphV2.invoke(
    {
      systemInstruction: params.systemInstruction,
      tools: params.tools,
      businessProfileId: params.businessProfileId,
      businessName: params.businessName,
      businessVoice: params.businessVoice,
      businessTone: params.businessTone,
      userId: profile.userId,
      customerPhone: params.customerPhone,
      channel: params.channel,
      contextQuality: params.contextQuality,
      availableChunkTypes: params.availableChunkTypes ?? [],
      externalSourceFailureBehaviors: params.externalSourceFailureBehaviors ?? {},
      policy,
      handoffEnabled: params.handoffEnabled ?? true,
      conversationId: params.conversationId,
      agentTurnId: params.agentTurnId,
      activeWorkflowId: params.activeWorkflowId ?? undefined,
      parentActionRunId: params.parentActionRunId ?? undefined,
      actionStepKey: params.actionStepKey ?? undefined,
      replyPolicy: params.replyPolicy,
      contents: [
        ...historyContents,
        { role: "user" as const, content: params.customerMessage || "" },
      ] as any,
      toolCalls: [] as any,
      turnCount: 0 as any,
      hadToolExecution: false as any,
      evidence: makeEmptyEvidence() as any,
      sessionStats: {
        promptTokens: 0,
        completionTokens: 0,
        groundingCalls: 0,
        lastBilledPromptTokens: 0,
        lastBilledCompletionTokens: 0,
        lastBilledGrounding: 0,
        modelName: "gemini-3-flash-preview",
      } as any,
      decision: null as any,
      queuedActionRunId: undefined as any,
    },
    {
      configurable: {
        thread_id: String(params.agentTurnId),
        graph_version: "v2",
      },
    },
  );

  if (!finalState.decision) {
    throw new Error("Graph V2 completed without a decision");
  }
  return finalState.decision;
}

function textFromLegacyParts(parts?: any[]): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}
