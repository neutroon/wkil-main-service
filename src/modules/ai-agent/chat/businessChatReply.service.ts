import type { Prisma } from "@prisma/client";
import { retrieveRelevantChunksWithEmbedding } from "../rag/rag.service";
import { buildSystemPrompt } from "../../meta/core/prompt.service";
import { buildAgentActionTools } from "@modules/ai-agent/core/agentActionTools";
import { runAgentGraphV2 } from "@modules/ai-agent/core/agentGraphV2";
import type { AiRoutingDecision } from "@modules/ai-agent/core/aiEngine.utils";
import {
  buildNotIngestedReply,
  buildTruthfulnessPolicyForVoice,
} from "./aiFallbackPolicy";
import { generateSafeRecoveryReply } from "./aiRecoveryReply";
import { enqueueCustomerMemoryCapture } from "@modules/meta/core/meta.queue";
import {
  createAgentTurn,
  updateAgentTurnStatus,
} from "@modules/ai-agent/core/agentTurn.service";
import {
  activeWorkflowSourceIds,
  listActiveAgentActionWorkflows,
} from "@modules/integrations/external/agentActionWorkflow.service";
import {
  buildCompletedActionReplyPolicy,
  replyPolicyPromptBlock,
} from "@modules/ai-agent/core/replyPolicy";
import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { env } from "@config/env";
import { effectiveCustomerRequestText } from "./completedActionRequest";
import {
  customerMessageForModel,
  type InboundMediaInfo,
} from "./messageSignals";
export type { AiRoutingDecision };

export type BusinessProfileForChat = Prisma.BusinessProfileGetPayload<{
  include: {
    agentActionSources: true;
  };
}>;

type CompletedExternalLookup = {
  sourceName?: string;
  toolName: string;
  envelope: {
    success: boolean;
    verification?: string;
    actionType?: string;
    reason?: string;
    data?: unknown;
    error?: string;
  };
};

type WorkflowContinuationContext = {
  activeWorkflowId: number;
  parentActionRunId: number;
  actionStepKey: "mutation";
  allowedActionSourceIds: number[];
  completedExternalLookup: CompletedExternalLookup;
};

type TimedResult<T> = {
  value: T;
  ms: number;
};

type AgentPrepTimings = {
  ragMs: number;
  workflowsMs: number;
  mediaMs: number;
  promptMs: number;
  ragTimeoutMs: number;
  prepLookupTimeoutMs: number;
};

const CORE_CONTEXT_TYPES = new Set(["identity", "contact", "intents"]);
const MUTATION_CORRECTION_WINDOW_MS = 24 * 60 * 60 * 1000;
const CHAT_RESPONSE_DEADLINE_BUFFER_MS = 250;

function ragTimeoutForChat(responseDeadlineAt?: number): number {
  if (!responseDeadlineAt) return env.AI_CHAT_RAG_TIMEOUT_MS;
  const remainingMs = responseDeadlineAt - Date.now() - CHAT_RESPONSE_DEADLINE_BUFFER_MS;
  return Math.max(1, Math.min(env.AI_CHAT_RAG_TIMEOUT_MS, remainingMs));
}

function prepLookupTimeoutForChat(responseDeadlineAt?: number): number {
  if (!responseDeadlineAt) return env.AI_CHAT_PREP_LOOKUP_TIMEOUT_MS;
  const remainingMs = responseDeadlineAt - Date.now() - CHAT_RESPONSE_DEADLINE_BUFFER_MS;
  return Math.max(1, Math.min(env.AI_CHAT_PREP_LOOKUP_TIMEOUT_MS, remainingMs));
}

async function timed<T>(operation: () => Promise<T>): Promise<TimedResult<T>> {
  const startedAt = Date.now();
  const value = await operation();
  return {
    value,
    ms: Date.now() - startedAt,
  };
}

async function timedWithFallback<T>(params: {
  operation: () => Promise<T>;
  timeoutMs: number;
  fallback: T;
  label: string;
  businessProfileId: number;
}): Promise<TimedResult<T>> {
  const startedAt = Date.now();
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeout = setTimeout(() => {
      logger.warn("ai.chat.prep_lookup_timeout", {
        businessProfileId: params.businessProfileId,
        label: params.label,
        timeoutMs: params.timeoutMs,
      });
      resolve(params.fallback);
    }, params.timeoutMs);
  });

  try {
    const value = await Promise.race([params.operation(), timeoutPromise]);
    return {
      value,
      ms: Date.now() - startedAt,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function notIngestedReply(params: {
  businessName: string;
  identity?: string | null;
  voice?: string | null;
  tone?: string | null;
  channel: "messenger" | "whatsapp" | "web" | "facebook_comment";
  messageText: string;
  handoffEnabled?: boolean;
}): Promise<AiRoutingDecision> {
  const voice = params.voice || "Professional";
  const systemInstruction = [
    `You are the official customer support representative for "${params.businessName}".`,
    "",
    "<persona>",
    `- Agency/Business: ${params.businessName}`,
    params.identity ? `- Identity: ${params.identity}` : "",
    `- Voice (Language/Dialect): ${voice}`,
    params.tone ? `- Tone: ${params.tone}` : "",
    "</persona>",
  ]
    .filter(Boolean)
    .join("\n");
  const content = await generateSafeRecoveryReply({
    systemInstruction,
    channel: params.channel,
    customerMessage: params.messageText,
    failureReason: "knowledge_not_ready",
    safeFallback: buildNotIngestedReply(voice),
    allowHandoffLanguage: params.handoffEnabled !== false,
  });

  return {
    action: params.handoffEnabled === false ? "REPLY_AUTO" : "HANDOFF_TO_HUMAN",
    handoffCategory: params.handoffEnabled === false ? null : "MISSING_KNOWLEDGE",
    reasoning: "Business profile knowledge base (RAG) is not yet ingested.",
    content,
  };
}

function resolveContextQuality(
  chunks: { chunkType: string; content: string }[],
): "specific_evidence_found" | "core_context_only" | "no_context" {
  if (chunks.length === 0) return "no_context";
  return chunks.some((chunk) => !CORE_CONTEXT_TYPES.has(chunk.chunkType))
    ? "specific_evidence_found"
    : "core_context_only";
}

/**
 * Shared RAG + tool + AI loop used by Messenger, WhatsApp, and web widget.
 * Does not persist messages — callers save user/model turns around this call.
 */
export async function prepareAgentParams(params: {
  businessProfile: BusinessProfileForChat;
  messageText: string;
  historyTurns: { role: "user" | "model"; text: string }[];
  channel: "messenger" | "whatsapp" | "web" | "facebook_comment";
  customerPhone?: string;
  mediaInfo?: InboundMediaInfo;
  postContext?: { content: string; media?: string };
  conversationId?: number;
  conversationRunId?: string;
  latestUserMessageId?: number;
  responseDeadlineAt?: number;
  agentTurnId?: number;
  activeWorkflowId?: number | null;
  parentActionRunId?: number | null;
  actionStepKey?: string | null;
  allowedActionSourceIds?: number[];
  completedExternalLookup?: CompletedExternalLookup;
}) {
  const {
    businessProfile,
    messageText,
    historyTurns,
    channel,
    customerPhone,
    conversationId,
    agentTurnId,
    activeWorkflowId,
    parentActionRunId,
    actionStepKey,
    allowedActionSourceIds,
    completedExternalLookup,
  } = params;

  if (!businessProfile.ragIngested) {
    return {
      errorDecision: await notIngestedReply({
        businessName: businessProfile.name,
        identity: businessProfile.identity,
        voice: businessProfile.voice,
        tone: businessProfile.tone,
        channel,
        messageText,
        handoffEnabled: businessProfile.handoffEnabled,
      }),
    };
  }

  const customerModelMessage = customerMessageForModel({
    messageText,
    mediaInfo: params.mediaInfo,
  });
  const effectiveMessageText = completedExternalLookup
    ? effectiveCustomerRequestText(messageText)
    : customerModelMessage;

  const ragTimeoutMs = ragTimeoutForChat(params.responseDeadlineAt);
  const prepLookupTimeoutMs = prepLookupTimeoutForChat(params.responseDeadlineAt);
  const retrievalResult = await timed(() =>
    retrieveRelevantChunksWithEmbedding(
      businessProfile.id,
      effectiveMessageText,
      5,
      {
        userId: businessProfile.userId,
        timeoutMs: ragTimeoutMs,
      },
    ),
  );
  const hasActionSources = (businessProfile.agentActionSources || []).some(
    (source) => source.isActive && (source as any).trigger === "CHAT_REQUESTED",
  );
  const activeWorkflowsPromise = timedWithFallback({
    operation: () =>
      hasActionSources
        ? listActiveAgentActionWorkflows(businessProfile.id)
        : Promise.resolve([]),
    timeoutMs: prepLookupTimeoutMs,
    fallback: [],
    label: "active_workflows",
    businessProfileId: businessProfile.id,
  });
  const mediaAssetsPromise = timedWithFallback({
    operation: () =>
      prisma.businessProfileMedia.findMany({
        where: {
          businessProfileId: businessProfile.id,
          usageScope: "CHAT_ATTACHMENT",
          isActive: true,
          deletedAt: null,
        },
        select: { name: true, mediaType: true, instructions: true },
      }),
    timeoutMs: prepLookupTimeoutMs,
    fallback: [],
    label: "media_assets",
    businessProfileId: businessProfile.id,
  });
  const [activeWorkflowsResult, mediaAssetsResult] = await Promise.all([
    activeWorkflowsPromise,
    mediaAssetsPromise,
  ]);
  const retrieval = retrievalResult.value;
  const activeWorkflows = activeWorkflowsResult.value;
  const mediaAssets = mediaAssetsResult.value;
  const relevantChunks = retrieval.chunks;
  const contextQuality = resolveContextQuality(relevantChunks);
  const availableChunkTypes = Array.from(
    new Set(relevantChunks.map((chunk) => chunk.chunkType)),
  );
  if (completedExternalLookup) {
    availableChunkTypes.push("external_tool");
  }

  const workflowStartSourceIds = activeWorkflowSourceIds(activeWorkflows);
  const activeAgentActionSources = (businessProfile.agentActionSources || []).filter(
    (source) => {
      if (!source.isActive || (source as any).trigger !== "CHAT_REQUESTED") {
        return false;
      }
      if (allowedActionSourceIds) {
        return allowedActionSourceIds.includes(source.id);
      }
      if (completedExternalLookup) {
        return false;
      }
      if (workflowStartSourceIds.size === 0) {
        return true;
      }
      if (workflowStartSourceIds.has(source.id)) {
        return true;
      }
      return !activeWorkflows.some(
        (workflow) =>
          workflow.mutationSourceId === source.id &&
          workflow.lookupSourceId !== null,
      );
    },
  );
  const eligibleExternalSources = activeAgentActionSources;
  const finalTools = buildAgentActionTools(eligibleExternalSources);
  const externalSourceFailureBehaviors = Object.fromEntries(
    eligibleExternalSources.map((source) => [
      source.id,
      source.failureBehavior || "AUTO",
    ]),
  );

  const promptStartedAt = Date.now();
  const systemInstruction = buildSystemPrompt({
    businessProfile: {
      name: businessProfile.name,
      identity: businessProfile.identity || "",
      voice: businessProfile.voice || "Professional",
      tone: businessProfile.tone || "Friendly",
      aiBehaviorInstructions:
        businessProfile.aiBehaviorInstructions || undefined,
    },
    context: relevantChunks,
    channel: channel,
    contextQuality,
    customerPhone,
    postContext: params.postContext,
    handoffEnabled: businessProfile.handoffEnabled,
    hasChatRequestedActions: finalTools.length > 0,
    hasMediaAssets: mediaAssets.length > 0,
    hasCompletedActionResult: Boolean(completedExternalLookup),
  });

  const replyPolicy = completedExternalLookup
    ? buildCompletedActionReplyPolicy({
        envelope: completedExternalLookup.envelope,
        handoffEnabled: businessProfile.handoffEnabled !== false,
      })
    : undefined;

  let finalSystemInstruction = systemInstruction;
  if (completedExternalLookup) {
    const serializedLookup = stringifyForPrompt(
      completedActionEnvelopeForPrompt(completedExternalLookup),
    );
    const actionChainInstruction = allowedActionSourceIds && allowedActionSourceIds.length > 0
        ? "This verified lookup/helper result may support one different exposed follow-up business action if the original customer request still requires that action. Do not call another lookup/helper action."
        : "Do not call any other action for this completed-action result turn.";
    finalSystemInstruction += `\n\n<completed_integration_action>\nThis action already ran after the previous chat turn. Do not call the same action again for this answer. Use this payload as evidence only when success is true and verification is "verified". If it failed, do not confirm completion, booking, submission, delivery, or saving.\n${actionChainInstruction}\nTool: ${completedExternalLookup.toolName}\nSource: ${completedExternalLookup.sourceName || "External action"}\nPayload JSON:\n${serializedLookup}\n</completed_integration_action>\n\nWhen your customer-facing answer relies on a verified action result, include "external_tool" in usedChunkTypes.`;
    if (replyPolicy) {
      finalSystemInstruction += `\n\n${replyPolicyPromptBlock(replyPolicy)}`;
    }
  }
  if (mediaAssets.length > 0) {
    const catalog = mediaAssets
      .map((a) => `- "${a.name}" (${a.mediaType}): ${a.instructions}`)
      .join("\n");
    finalSystemInstruction += `\n\n<media_catalog>\nYou may send one file per response using the attachment field.\nAvailable assets:\n${catalog}\n\nRules:\n1. Only reference exact names from the list above.\n2. Never invent an asset name.\n3. Never send attachments to public Facebook comments.\n4. Only attach a file when it is genuinely relevant to the customer's request.\n</media_catalog>`;
  }
  const promptMs = Date.now() - promptStartedAt;
  const prepTimings: AgentPrepTimings = {
    ragMs: retrievalResult.ms,
    workflowsMs: activeWorkflowsResult.ms,
    mediaMs: mediaAssetsResult.ms,
    promptMs,
    ragTimeoutMs,
    prepLookupTimeoutMs,
  };

  logger.info("ai.chat.prepared_tools", {
    businessProfileId: businessProfile.id,
    channel,
    customerDetailsToolExposed: false,
    activeActionSourceCount: activeAgentActionSources.length,
    eligibleExternalSourceIds: eligibleExternalSources.map((source) => source.id),
    toolNames: finalTools.map((tool) => tool.name),
    ...prepTimings,
  });

  return {
    prepTimings,
    graphParams: {
      systemInstruction: finalSystemInstruction,
      historyTurns,
      customerMessage: customerModelMessage,
      tools: finalTools.length > 0 ? finalTools : undefined,
      businessProfileId: businessProfile.id,
      userId: businessProfile.userId,
      businessName: businessProfile.name,
      businessVoice: businessProfile.voice || undefined,
      businessTone: businessProfile.tone || undefined,
      customerPhone,
      channel,
      contextQuality,
      availableChunkTypes,
      externalSourceFailureBehaviors,
      conversationId,
      conversationRunId: params.conversationRunId,
      latestUserMessageId: params.latestUserMessageId,
      responseDeadlineAt: params.responseDeadlineAt,
      agentTurnId,
      activeWorkflowId,
      parentActionRunId,
      actionStepKey,
      replyPolicy,
      handoffEnabled: businessProfile.handoffEnabled,
      policy: buildTruthfulnessPolicyForVoice(businessProfile.voice || ""),
    },
  };
}

function stringifyForPrompt(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseIntegrationActionSourceId(toolName: string): number | null {
  const match = toolName.match(/^integration_action_(\d+)$/);
  if (!match) return null;
  const sourceId = Number(match[1]);
  return Number.isInteger(sourceId) ? sourceId : null;
}

function isVerifiedCompletedAction(completed: CompletedExternalLookup): boolean {
  return completed.envelope.success === true &&
    completed.envelope.verification === "verified";
}

function isLookupActionSource(source: unknown): boolean {
  return String((source as any)?.actionType || "").toUpperCase() === "LOOKUP";
}

function isMutationActionSource(source: unknown): boolean {
  return String((source as any)?.actionType || "").toUpperCase() === "MUTATION";
}

function canExposeFollowUpActionsAfterCompletedAction(
  completed: CompletedExternalLookup,
  completedSource: unknown,
): boolean {
  return isVerifiedCompletedAction(completed) && isLookupActionSource(completedSource);
}

function completedActionEnvelopeForPrompt(
  completed: CompletedExternalLookup,
): CompletedExternalLookup["envelope"] {
  if (isVerifiedCompletedAction(completed)) {
    return {
      success: completed.envelope.success,
      verification: completed.envelope.verification,
      actionType: completed.envelope.actionType,
      reason: completed.envelope.reason,
      data: completed.envelope.data,
    };
  }

  return {
    success: false,
    verification: "failed",
    actionType: completed.envelope.actionType,
    reason: completedActionFailureCode(completed.envelope.reason),
    data: completed.envelope.data ?? null,
    error: customerSafeCompletedActionError(completed.envelope.error),
  };
}

function completedActionFailureCode(reason?: string): string {
  if (!reason) return "action_result_failed";
  const normalized = reason.toLowerCase();
  if (normalized.includes("policy")) return "action_policy_rejected";
  if (normalized.includes("timeout")) return "action_timeout";
  if (normalized.includes("validation") || normalized.includes("422")) {
    return "action_validation_failed";
  }
  return "action_result_failed";
}

function customerSafeCompletedActionError(error?: string): string | undefined {
  if (!error) return undefined;
  if (/^External API returned status \d+$/i.test(error.trim())) return undefined;
  return error.slice(0, 500);
}


/**
 * Standard (non-streaming) AI loop execution.
 */
export async function computeBusinessChatReply(params: {
  businessProfile: BusinessProfileForChat;
  messageText: string;
  historyTurns: { role: "user" | "model"; text: string }[];
  channel: "messenger" | "whatsapp" | "web" | "facebook_comment";
  customerPhone?: string;
  mediaInfo?: InboundMediaInfo;
  postContext?: { content: string; media?: string };
  conversationId?: number;
  conversationRunId?: string;
  latestUserMessageId?: number;
  agentTurnId?: number;
  activeWorkflowId?: number | null;
  parentActionRunId?: number | null;
  actionStepKey?: string | null;
  allowedActionSourceIds?: number[];
  completedExternalLookup?: CompletedExternalLookup;
}): Promise<AiRoutingDecision> {
  const startedAt = Date.now();
  const responseDeadlineAt = startedAt + env.AI_CHAT_RESPONSE_DEADLINE_MS;
  const continuation = await findPendingMutationCorrectionContext(params);
  const graphInputBase = {
    ...params,
    responseDeadlineAt,
  };
  const graphInput = continuation
    ? {
        ...graphInputBase,
        activeWorkflowId: continuation.activeWorkflowId,
        parentActionRunId: continuation.parentActionRunId,
        actionStepKey: continuation.actionStepKey,
        allowedActionSourceIds: continuation.allowedActionSourceIds,
        completedExternalLookup: continuation.completedExternalLookup,
      }
    : graphInputBase;

  const prepStartedAt = Date.now();
  const prep = await prepareAgentParams(graphInput);
  const prepMs = Date.now() - prepStartedAt;
  if (prep.errorDecision) {
    logger.info("ai.chat.reply_latency", {
      businessProfileId: params.businessProfile.id,
      channel: params.channel,
      totalMs: Date.now() - startedAt,
      prepMs,
      ...(prep.prepTimings ?? {}),
      graphMs: 0,
      underFiveSeconds: Date.now() - startedAt < 5000,
      path: "preflight_error_decision",
    });
    return prep.errorDecision;
  }

  let agentTurnId = params.agentTurnId;
  if (!agentTurnId && params.conversationId) {
    const turn = await createAgentTurn({
      businessProfileId: params.businessProfile.id,
      conversationId: params.conversationId,
      inputMessageId: params.latestUserMessageId ?? null,
      channel: params.channel,
      mode: params.completedExternalLookup ? "ACTION_RESULT" : "CUSTOMER_MESSAGE",
      customerText: params.messageText,
      parentActionRunId:
        params.parentActionRunId ?? continuation?.parentActionRunId ?? null,
      activeWorkflowId:
        params.activeWorkflowId ?? continuation?.activeWorkflowId ?? null,
    });
    agentTurnId = turn.id;
  }

  const graphStartedAt = Date.now();
  const decision = await runAgentGraphV2({
    ...prep.graphParams!,
    agentTurnId: agentTurnId ?? Date.now(),
  });
  const graphMs = Date.now() - graphStartedAt;
  if (agentTurnId) {
    void updateAgentTurnStatus(
      agentTurnId,
      decision.agentTurnStatus || "COMPLETED",
    );
  }
  if (!params.completedExternalLookup) {
    enqueueCustomerMemoryCaptureFromChat(params);
  }
  logger.info("ai.chat.reply_latency", {
    businessProfileId: params.businessProfile.id,
    channel: params.channel,
    conversationId: params.conversationId,
    totalMs: Date.now() - startedAt,
    prepMs,
    ...(prep.prepTimings ?? {}),
    graphMs,
    underFiveSeconds: Date.now() - startedAt < 5000,
    action: decision.action,
    replyType: decision.replyType,
    toolCount: prep.graphParams?.tools?.length ?? 0,
  });
  return decision;
}

async function findPendingMutationCorrectionContext(params: {
  businessProfile: BusinessProfileForChat;
  conversationId?: number;
  completedExternalLookup?: CompletedExternalLookup;
  allowedActionSourceIds?: number[];
}): Promise<WorkflowContinuationContext | null> {
  if (!params.conversationId || params.completedExternalLookup) return null;
  if (params.allowedActionSourceIds && params.allowedActionSourceIds.length > 0) {
    return null;
  }

  const cutoff = new Date(Date.now() - MUTATION_CORRECTION_WINDOW_MS);
  const failedRun = await prisma.integrationActionRun.findFirst({
    where: {
      businessProfileId: params.businessProfile.id,
      conversationId: params.conversationId,
      OR: [
        { status: "FAILED" },
        { status: "SKIPPED", failureReason: "stale_customer_message" },
      ],
      actionType: "MUTATION",
      workflowId: { not: null },
      parentRunId: { not: null },
      createdAt: { gte: cutoff },
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    include: {
      source: true,
      workflow: { include: { mutationSource: true } },
      parentRun: { include: { source: true } },
    },
  });

  if (
    !failedRun?.workflowId ||
    !failedRun.parentRunId ||
    !failedRun.workflow?.mutationSource?.isActive ||
    failedRun.workflow.mutationSourceId !== failedRun.sourceId
  ) {
    return null;
  }

  const newerRetry = await prisma.integrationActionRun.findFirst({
    where: {
      businessProfileId: params.businessProfile.id,
      conversationId: params.conversationId,
      workflowId: failedRun.workflowId,
      sourceId: failedRun.sourceId,
      actionType: "MUTATION",
      id: { not: failedRun.id },
      createdAt: { gt: failedRun.createdAt },
      status: { in: ["QUEUED", "RUNNING", "SUCCEEDED"] },
    },
    select: { id: true },
  });
  if (newerRetry) return null;

  const parentEnvelope = failedRun.parentRun?.responsePayload as
    | CompletedExternalLookup["envelope"]
    | null
    | undefined;
  if (
    !parentEnvelope ||
    parentEnvelope.success !== true ||
    parentEnvelope.verification !== "verified"
  ) {
    return null;
  }

  return {
    activeWorkflowId: failedRun.workflowId,
    parentActionRunId: failedRun.parentRunId,
    actionStepKey: "mutation",
    allowedActionSourceIds: [failedRun.sourceId],
    completedExternalLookup: {
      sourceName: failedRun.parentRun?.source?.name || "Previous action result",
      toolName:
        failedRun.parentRun?.toolName ||
        `integration_action_${failedRun.parentRun?.sourceId || failedRun.sourceId}`,
      envelope: parentEnvelope,
    },
  };
}

function enqueueCustomerMemoryCaptureFromChat(params: {
  businessProfile: BusinessProfileForChat;
  messageText: string;
  historyTurns: { role: "user" | "model"; text: string }[];
  channel: "messenger" | "whatsapp" | "web" | "facebook_comment";
  customerPhone?: string;
  conversationId?: number;
}) {
  if (!params.conversationId || !params.messageText.trim()) return;

  enqueueCustomerMemoryCapture({
    businessProfileId: params.businessProfile.id,
    conversationId: params.conversationId,
    channel: params.channel,
    customerPhone: params.customerPhone,
    latestUserText: params.messageText,
    recentTurns: params.historyTurns.slice(-20),
  }).catch((error: any) => {
    logger.error("ai.chat.customer_memory_capture_enqueue_failed", {
      businessProfileId: params.businessProfile.id,
      conversationId: params.conversationId,
      error: error?.message || String(error),
    });
  });
}
