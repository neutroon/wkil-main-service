import type { Prisma } from "@prisma/client";
import type { Tool } from "@google/genai";
import { retrieveRelevantChunks } from "../rag/rag.service";
import { buildSystemPrompt } from "../../meta/core/prompt.service";
import {
  buildCaptureLeadTool,
  buildExternalQueryTools,
} from "@modules/ai-agent/gemini";
import { runAgentGraph } from "@modules/ai-agent/core/agentGraph";
import type { AiRoutingDecision } from "@modules/ai-agent/core/aiEngine.utils";
import {
  buildNotIngestedReply,
  buildTruthfulnessPolicyForVoice,
} from "./aiFallbackPolicy";
import { filterEligibleExternalDataSources } from "./externalToolEligibility";
import { shouldExposeCrmTool } from "./crmToolEligibility";
import prisma from "@config/prisma";
import { logger } from "@utils/logger";
export type { AiRoutingDecision };

export type BusinessProfileForChat = Prisma.BusinessProfileGetPayload<{
  include: {
    externalDataSources: true;
    crmIntegrations: true;
  };
}>;

const CORE_CONTEXT_TYPES = new Set(["identity", "contact", "intents"]);

function notIngestedReply(voice: string): AiRoutingDecision {
  return {
    action: "HANDOFF_TO_HUMAN",
    handoffCategory: "MISSING_KNOWLEDGE",
    reasoning: "Business profile knowledge base (RAG) is not yet ingested.",
    content: buildNotIngestedReply(voice),
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
}) {
  const {
    businessProfile,
    messageText,
    historyTurns,
    channel,
    customerPhone,
    conversationId,
    responseMode,
  } = params;

  if (!businessProfile.ragIngested) {
    return { errorDecision: notIngestedReply(businessProfile.voice || "") };
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

  const crmIntegration = businessProfile.crmIntegrations?.[0];
  const crmFields = crmIntegration?.fieldMapping 
    ? Object.entries(crmIntegration.fieldMapping as object)
        .filter(([_, v]) => isAiWritableFieldRule(v))
        .map(([k]) => k)
        .filter(k => !["name", "phone"].includes(k)) // Still skip these as they are handled by hard rules
    : [];

  const systemInstruction = buildSystemPrompt({
    businessProfile: {
      name: businessProfile.name,
      identity: businessProfile.identity || "",
      voice: businessProfile.voice || "Professional",
      tone: businessProfile.tone || "Friendly",
      leadCaptureInstructions:
        businessProfile.leadCaptureInstructions || undefined,
      aiBehaviorInstructions:
        businessProfile.aiBehaviorInstructions || undefined,
    },
    context: relevantChunks,
    channel: channel,
    contextQuality,
    customerPhone,
    postContext: params.postContext,
    crmFields,
  });

  const mediaAssets = await prisma.businessProfileMedia.findMany({
    where: {
      businessProfileId: businessProfile.id,
      usageScope: "CHAT_ATTACHMENT",
      isActive: true,
      deletedAt: null,
    },
    select: { name: true, mediaType: true, instructions: true },
  });

  let finalSystemInstruction = systemInstruction;
  if (mediaAssets.length > 0) {
    const catalog = mediaAssets
      .map((a) => `- "${a.name}" (${a.mediaType}): ${a.instructions}`)
      .join("\n");
    finalSystemInstruction += `\n\n## MEDIA CATALOG\nYou MAY send one file per response using the "attachment" field in your JSON output.\nAvailable assets:\n${catalog}\n\nCRITICAL RULES:\n1. Only reference EXACT names from the list above.\n2. NEVER invent an asset name.\n3. NEVER send attachments to public Facebook Comments.\n4. Only attach a file when it is genuinely relevant to the customer's request.`;
  }

  const [canExposeCrmTool, eligibleExternalSources] = await Promise.all([
    shouldExposeCrmTool({
      latestUserMessage: messageText,
      leadCaptureInstructions: businessProfile.leadCaptureInstructions,
      integration: crmIntegration,
    }),
    filterEligibleExternalDataSources(
      businessProfile.externalDataSources,
      messageText,
    ),
  ]);
  const captureTool =
    canExposeCrmTool && businessProfile.crmIntegrations.length > 0
      ? buildCaptureLeadTool(
          businessProfile.crmIntegrations[0].fieldMapping,
          businessProfile.leadCaptureInstructions || undefined,
        )
      : [];
  const externalTools = buildExternalQueryTools(eligibleExternalSources);

  const toolBlocks: Tool[] = [];
  if (captureTool.length > 0) toolBlocks.push(...captureTool);
  if (externalTools.length > 0) toolBlocks.push(...externalTools);

  const mergedDeclarations = toolBlocks.flatMap(
    (t) => t.functionDeclarations ?? [],
  );
  const finalTools: Tool[] | undefined =
    mergedDeclarations.length > 0
      ? [{ functionDeclarations: mergedDeclarations }]
      : undefined;

  logger.info("ai.chat.prepared_tools", {
    businessProfileId: businessProfile.id,
    channel,
    crmToolExposed: captureTool.length > 0,
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
      customerPhone,
      channel,
      contextQuality,
      availableChunkTypes,
      mediaInfo: params.mediaInfo,
      conversationId,
      responseMode,
      policy: buildTruthfulnessPolicyForVoice(businessProfile.voice || ""),
    },
  };
}

function isAiWritableFieldRule(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  if (String(rule.type ?? "").toUpperCase() === "FIXED") return false;
  const source = String(rule.source ?? "USER_PROVIDED").toUpperCase();
  return source === "USER_PROVIDED" || source === "AI_DERIVED";
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
