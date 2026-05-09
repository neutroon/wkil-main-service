import type { Prisma } from "@prisma/client";
import type { Tool } from "@google/genai";
import { retrieveRelevantChunks } from "../rag/rag.service";
import { buildSystemPrompt } from "../../meta/core/prompt.service";
import {
  buildSaveCustomerDetailsTool,
  buildIntegrationActionTools,
} from "@modules/ai-agent/gemini";
import { runAgentGraph } from "@modules/ai-agent/core/agentGraph";
import type { AiRoutingDecision } from "@modules/ai-agent/core/aiEngine.utils";
import {
  buildNotIngestedReply,
  buildTruthfulnessPolicyForVoice,
} from "./aiFallbackPolicy";
import { generateSafeRecoveryReply } from "./aiRecoveryReply";
import { filterEligibleExternalDataSources } from "./externalToolEligibility";
import prisma from "@config/prisma";
import { logger } from "@utils/logger";
export type { AiRoutingDecision };

export type BusinessProfileForChat = Prisma.BusinessProfileGetPayload<{
  include: {
    externalDataSources: true;
    crmIntegrations: true;
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
    allowHandoffLanguage: true,
  });

  return {
    action: "HANDOFF_TO_HUMAN",
    handoffCategory: "MISSING_KNOWLEDGE",
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
  responseMode?: "AUTO" | "MANUAL";
  completedExternalLookup?: CompletedExternalLookup;
}) {
  const {
    businessProfile,
    messageText,
    historyTurns,
    channel,
    customerPhone,
    conversationId,
    responseMode,
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
      }),
    };
  }

  const relevantChunks = await retrieveRelevantChunks(
    businessProfile.id,
    messageText,
    5,
  );
  const contextQuality = resolveContextQuality(relevantChunks);
  const availableChunkTypes = Array.from(
    new Set(relevantChunks.map((chunk) => chunk.chunkType)),
  );
  if (completedExternalLookup) {
    availableChunkTypes.push("external_tool");
  }

  const activeExternalDataSources = completedExternalLookup
    ? []
    : (businessProfile.externalDataSources || []).filter(
        (source) => source.isActive && (source as any).trigger === "CHAT_REQUESTED",
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

  const externalRouterPromise = activeExternalDataSources.length > 0
    ? filterEligibleExternalDataSources(
        activeExternalDataSources,
        messageText,
      )
    : Promise.resolve([]);
  const eligibleExternalSources = await externalRouterPromise;
  const customerDetailsTool = buildSaveCustomerDetailsTool(
    undefined,
    businessProfile.customerDetailsInstructions || undefined,
  );
  const externalTools = buildIntegrationActionTools(eligibleExternalSources);
  const externalSourceFailureBehaviors = Object.fromEntries(
    eligibleExternalSources.map((source) => [
      source.id,
      source.failureBehavior || "AUTO",
    ]),
  );

  const toolBlocks: Tool[] = [];
  toolBlocks.push(...customerDetailsTool);
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
      customerDetailsInstructions:
        businessProfile.customerDetailsInstructions || undefined,
      aiBehaviorInstructions:
        businessProfile.aiBehaviorInstructions || undefined,
    },
    context: relevantChunks,
    channel: channel,
    contextQuality,
    customerPhone,
    postContext: params.postContext,
    hasCustomerMemoryTool: customerDetailsTool.length > 0,
    hasChatRequestedActions: externalTools.length > 0,
    hasMediaAssets: mediaAssets.length > 0,
    hasCompletedActionResult: Boolean(completedExternalLookup),
  });

  let finalSystemInstruction = systemInstruction;
  if (completedExternalLookup) {
    const serializedLookup = stringifyForPrompt(
      completedExternalLookup.envelope,
      MAX_EXTERNAL_LOOKUP_PROMPT_CHARS,
    );
    finalSystemInstruction += `\n\n<completed_integration_action>\nThis action already ran after the previous chat turn. Do not call the same action again for this answer. Use this payload as verified evidence only when verification is "verified"; if it failed, explain that the result could not be verified and ask for the exact missing or corrected detail.\nTool: ${completedExternalLookup.toolName}\nSource: ${completedExternalLookup.sourceName || "External action"}\nPayload JSON:\n${serializedLookup}\n</completed_integration_action>\n\nWhen your customer-facing answer relies on this action result, include "external_tool" in usedChunkTypes.`;
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
    customerDetailsToolExposed: true,
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
      responseMode,
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
  responseMode?: "AUTO" | "MANUAL";
  completedExternalLookup?: CompletedExternalLookup;
}): Promise<AiRoutingDecision> {
  const prep = await prepareAgentParams(params);
  if (prep.errorDecision) return prep.errorDecision;

  return runAgentGraph(prep.graphParams!);
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
  responseMode?: "AUTO" | "MANUAL";
}) {
  const prep = await prepareAgentParams(params);
  if (prep.errorDecision) {
    yield { type: "error", data: prep.errorDecision };
    return;
  }

  const { streamAgentGraph } = await import("../core/streamAgent");
  for await (const event of streamAgentGraph(prep.graphParams!)) {
    yield event;
  }
}
