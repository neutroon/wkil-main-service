import type { Prisma } from "@prisma/client";
import type { Tool } from "@google/genai";
import { retrieveRelevantChunksWithEmbedding } from "../rag/rag.service";
import { buildSystemPrompt } from "../../meta/core/prompt.service";
import { buildIntegrationActionTools } from "@modules/ai-agent/gemini";
import { runAgentGraphV2 } from "@modules/ai-agent/core/agentGraphV2";
import type { AiRoutingDecision } from "@modules/ai-agent/core/aiEngine.utils";
import {
  buildNotIngestedReply,
  buildTruthfulnessPolicyForVoice,
} from "./aiFallbackPolicy";
import { generateSafeRecoveryReply } from "./aiRecoveryReply";
import { filterEligibleAgentActionSources } from "./externalToolEligibility";
import { enqueueCustomerMemoryCapture } from "@modules/meta/core/meta.queue";
import {
  createAgentTurn,
  updateAgentTurnStatus,
} from "@modules/ai-agent/core/agentTurn.service";
import { ensureExternalActionSemanticIndexes } from "@modules/integrations/external/agentActionSemanticIndex.service";
import {
  activeWorkflowSourceIds,
  listActiveAgentActionWorkflows,
} from "@modules/integrations/external/agentActionWorkflow.service";
import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { effectiveCustomerRequestText } from "./completedActionRequest";
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

const CORE_CONTEXT_TYPES = new Set(["identity", "contact", "intents"]);
const MAX_EXTERNAL_LOOKUP_PROMPT_CHARS = 12_000;

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
  mediaInfo?: { id: string; type: string; url?: string };
  postContext?: { content: string; media?: string };
  conversationId?: number;
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

  const effectiveMessageText = completedExternalLookup
    ? effectiveCustomerRequestText(messageText)
    : messageText;

  const retrieval = await retrieveRelevantChunksWithEmbedding(
    businessProfile.id,
    effectiveMessageText,
    5,
  );
  const relevantChunks = retrieval.chunks;
  const contextQuality = resolveContextQuality(relevantChunks);
  const availableChunkTypes = Array.from(
    new Set(relevantChunks.map((chunk) => chunk.chunkType)),
  );
  if (completedExternalLookup) {
    availableChunkTypes.push("external_tool");
  }

  const activeWorkflows = await listActiveAgentActionWorkflows(businessProfile.id);
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

  const mediaAssets = await prisma.businessProfileMedia.findMany({
    where: {
      businessProfileId: businessProfile.id,
      usageScope: "CHAT_ATTACHMENT",
      isActive: true,
      deletedAt: null,
    },
    select: { name: true, mediaType: true, instructions: true },
  });

  const eligibleExternalSources = allowedActionSourceIds
    ? activeAgentActionSources
    : activeAgentActionSources.length > 0
      ? await ensureExternalActionSemanticIndexes(activeAgentActionSources).then(() =>
          filterEligibleAgentActionSources(activeAgentActionSources, effectiveMessageText, {
            businessProfileId: businessProfile.id,
            queryEmbedding: retrieval.queryEmbedding,
          }),
        )
      : [];
  const externalTools = buildIntegrationActionTools(eligibleExternalSources);
  const externalSourceFailureBehaviors = Object.fromEntries(
    eligibleExternalSources.map((source) => [
      source.id,
      source.failureBehavior || "AUTO",
    ]),
  );

  const toolBlocks: Tool[] = [];
  if (externalTools.length > 0) toolBlocks.push(...externalTools);

  const mergedDeclarations = toolBlocks.flatMap(
    (t) => t.functionDeclarations ?? [],
  );
  const finalTools: Tool[] | undefined =
    mergedDeclarations.length > 0
      ? [{ functionDeclarations: mergedDeclarations }]
      : undefined;

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
    hasChatRequestedActions: externalTools.length > 0,
    hasMediaAssets: mediaAssets.length > 0,
    hasCompletedActionResult: Boolean(completedExternalLookup),
  });

  let finalSystemInstruction = systemInstruction;
  if (completedExternalLookup) {
    const serializedLookup = stringifyForPrompt(
      completedActionEnvelopeForPrompt(completedExternalLookup),
      MAX_EXTERNAL_LOOKUP_PROMPT_CHARS,
    );
    const actionChainInstruction = allowedActionSourceIds && allowedActionSourceIds.length > 0
      ? "This verified lookup/helper result may support one different exposed follow-up business action if the original customer request still requires that action. Do not call another lookup/helper action."
      : "Do not call any other action for this completed-action result turn. If this result failed, explain that the request could not be completed safely and ask for the exact corrected or missing detail.";
    finalSystemInstruction += `\n\n<completed_integration_action>\nThis action already ran after the previous chat turn. Do not call the same action again for this answer. Use this payload as evidence only when success is true and verification is "verified". If it failed, do not confirm completion, booking, submission, delivery, or saving.\n${actionChainInstruction}\nTool: ${completedExternalLookup.toolName}\nSource: ${completedExternalLookup.sourceName || "External action"}\nPayload JSON:\n${serializedLookup}\n</completed_integration_action>\n\nWhen your customer-facing answer relies on a verified action result, include "external_tool" in usedChunkTypes.`;
  }
  if (mediaAssets.length > 0) {
    const catalog = mediaAssets
      .map((a) => `- "${a.name}" (${a.mediaType}): ${a.instructions}`)
      .join("\n");
    finalSystemInstruction += `\n\n<media_catalog>\nYou may send one file per response using the attachment field.\nAvailable assets:\n${catalog}\n\nRules:\n1. Only reference exact names from the list above.\n2. Never invent an asset name.\n3. Never send attachments to public Facebook comments.\n4. Only attach a file when it is genuinely relevant to the customer's request.\n</media_catalog>`;
  }

  logger.info("ai.chat.prepared_tools", {
    businessProfileId: businessProfile.id,
    channel,
    customerDetailsToolExposed: false,
    eligibleExternalSourceIds: eligibleExternalSources.map((source) => source.id),
    toolNames: mergedDeclarations.map((declaration) => declaration.name),
  });

  return {
    graphParams: {
      systemInstruction: finalSystemInstruction,
      historyTurns,
      customerMessage: messageText,
      tools: finalTools,
      businessProfileId: businessProfile.id,
      businessName: businessProfile.name,
      businessVoice: businessProfile.voice || undefined,
      businessTone: businessProfile.tone || undefined,
      customerPhone,
      channel,
      contextQuality,
      availableChunkTypes,
      externalSourceFailureBehaviors,
      mediaInfo: params.mediaInfo,
      conversationId,
      agentTurnId,
      activeWorkflowId,
      parentActionRunId,
      actionStepKey,
      handoffEnabled: businessProfile.handoffEnabled,
      policy: buildTruthfulnessPolicyForVoice(businessProfile.voice || ""),
    },
  };
}

function stringifyForPrompt(value: unknown, maxChars: number): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated]`;
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
  if (isVerifiedCompletedAction(completed)) return completed.envelope;

  return {
    success: false,
    verification: "failed",
    actionType: completed.envelope.actionType,
    reason: completedActionFailureCode(completed.envelope.reason),
    data: null,
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

/**
 * Standard (non-streaming) AI loop execution.
 */
export async function computeBusinessChatReply(params: {
  businessProfile: BusinessProfileForChat;
  messageText: string;
  historyTurns: { role: "user" | "model"; text: string }[];
  channel: "messenger" | "whatsapp" | "web" | "facebook_comment";
  customerPhone?: string;
  mediaInfo?: { id: string; type: string; url?: string };
  postContext?: { content: string; media?: string };
  conversationId?: number;
  agentTurnId?: number;
  activeWorkflowId?: number | null;
  parentActionRunId?: number | null;
  actionStepKey?: string | null;
  allowedActionSourceIds?: number[];
  completedExternalLookup?: CompletedExternalLookup;
}): Promise<AiRoutingDecision> {
  const prep = await prepareAgentParams(params);
  if (prep.errorDecision) return prep.errorDecision;

  let agentTurnId = params.agentTurnId;
  if (!agentTurnId && params.conversationId) {
    const turn = await createAgentTurn({
      businessProfileId: params.businessProfile.id,
      conversationId: params.conversationId,
      channel: params.channel,
      mode: params.completedExternalLookup ? "ACTION_RESULT" : "CUSTOMER_MESSAGE",
      customerText: params.messageText,
      parentActionRunId: params.parentActionRunId ?? null,
      activeWorkflowId: params.activeWorkflowId ?? null,
    });
    agentTurnId = turn.id;
  }

  const decision = await runAgentGraphV2({
    ...prep.graphParams!,
    agentTurnId: agentTurnId ?? Date.now(),
  });
  if (agentTurnId) {
    await updateAgentTurnStatus(
      agentTurnId,
      decision.agentTurnStatus || "COMPLETED",
    );
  }
  if (!params.completedExternalLookup) {
    enqueueCustomerMemoryCaptureFromChat(params);
  }
  return decision;
}

/**
 * Streaming AI loop execution.
 */
export async function* computeBusinessChatStreaming(params: {
  businessProfile: BusinessProfileForChat;
  messageText: string;
  historyTurns: { role: "user" | "model"; text: string }[];
  channel: "web"; // Currently only web supports streaming
  customerPhone?: string;
  conversationId?: number;
}) {
  let agentTurnId = Date.now();
  let persistedTurnId: number | null = null;
  if (params.conversationId) {
    const turn = await createAgentTurn({
      businessProfileId: params.businessProfile.id,
      conversationId: params.conversationId,
      channel: params.channel,
      mode: "CUSTOMER_MESSAGE",
      customerText: params.messageText,
    });
    agentTurnId = turn.id;
    persistedTurnId = turn.id;
  }

  const prep = await prepareAgentParams({ ...params, agentTurnId });
  if (prep.errorDecision) {
    yield { type: "error", data: prep.errorDecision };
    if (persistedTurnId) await updateAgentTurnStatus(persistedTurnId, "FAILED");
    return;
  }

  enqueueCustomerMemoryCaptureFromChat(params);
  const { streamAgentGraph } = await import("../core/streamAgent");
  for await (const event of streamAgentGraph({
    ...prep.graphParams!,
    agentTurnId,
  })) {
    if (event.type === "final_decision" && persistedTurnId) {
      await updateAgentTurnStatus(
        persistedTurnId,
        event.data?.agentTurnStatus || "COMPLETED",
      );
    }
    yield event;
  }
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
