import type { Prisma } from "@prisma/client";
import type { Tool } from "@google/genai";
import { retrieveRelevantChunks } from "../../rag/rag.service";
import { buildSystemPrompt } from "../meta/prompt.service";
import {
  buildCaptureLeadTool,
  buildExternalQueryTools,
} from "../../config/gemini";
import { runAgentGraph } from "../ai/agentGraph";
import type { AiRoutingDecision } from "../ai/aiEngine.service";
import prisma from "../../config/prisma";
export type { AiRoutingDecision };

export const NOT_INGESTED_REPLY: AiRoutingDecision = {
  action: "HANDOFF_TO_HUMAN",
  handoffCategory: "MISSING_KNOWLEDGE",
  reasoning: "Business profile knowledge base (RAG) is not yet ingested.",
  content: "We're still setting up our assistant. Please contact us directly for now - we'll be with you shortly."
};

export type BusinessProfileForChat = Prisma.BusinessProfileGetPayload<{
  include: {
    externalDataSources: true;
    crmIntegrations: true;
  };
}>;

/**
 * Shared RAG + tool + AI loop used by Messenger, WhatsApp, and web widget.
 * Does not persist messages — callers save user/model turns around this call.
 */
export async function computeBusinessChatReply(params: {
  businessProfile: BusinessProfileForChat;
  messageText: string;
  historyTurns: { role: "user" | "model"; text: string }[];
  channel: "messenger" | "whatsapp" | "web";
  customerPhone?: string;
  mediaInfo?: { id: string; type: string; url?: string };
  postContext?: { content: string; media?: string };
  conversationId?: number;
}): Promise<AiRoutingDecision> {
  const {
    businessProfile,
    messageText,
    historyTurns,
    channel,
    customerPhone,
    conversationId,
  } = params;

  if (!businessProfile.ragIngested) {
    return NOT_INGESTED_REPLY;
  }

  const relevantChunks = await retrieveRelevantChunks(
    businessProfile.id,
    messageText,
    5,
  );

  const systemInstruction = buildSystemPrompt({
    businessProfile: {
      name: businessProfile.name,
      identity: businessProfile.identity || "",
      voice: businessProfile.voice || "Professional",
      tone: businessProfile.tone || "Friendly",
      leadCaptureInstructions: businessProfile.leadCaptureInstructions || undefined,
    },
    context: relevantChunks,
    channel,
    customerPhone,
    postContext: params.postContext,
  });

  // Inject Media Catalog — names + instructions only, NEVER raw platform IDs
  const mediaAssets = await prisma.businessProfileMedia.findMany({
    where: { businessProfileId: businessProfile.id, isActive: true, deletedAt: null },
    select: { name: true, mediaType: true, instructions: true },
  });

  let finalSystemInstruction = systemInstruction;
  if (mediaAssets.length > 0) {
    const catalog = mediaAssets
      .map((a) => `- "${a.name}" (${a.mediaType}): ${a.instructions}`)
      .join("\n");
    finalSystemInstruction += `\n\n## MEDIA CATALOG\nYou MAY send one file per response using the "attachment" field in your JSON output.\nAvailable assets:\n${catalog}\n\nCRITICAL RULES:\n1. Only reference EXACT names from the list above.\n2. NEVER invent an asset name.\n3. NEVER send attachments to public Facebook Comments.\n4. Only attach a file when it is genuinely relevant to the customer's request.`;
  }

  const captureTool =
    businessProfile.crmIntegrations.length > 0
      ? buildCaptureLeadTool(
          businessProfile.crmIntegrations[0].fieldMapping,
          businessProfile.leadCaptureInstructions || undefined
        )
      : [];
  const externalTools = buildExternalQueryTools(
    businessProfile.externalDataSources,
  );

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

  // ── LangGraph Agent (with automatic fallback to legacy loop) ─────────────
  return runAgentGraph({
    systemInstruction: finalSystemInstruction,
    historyTurns,
    customerMessage:   messageText,
    tools:             finalTools,
    businessProfileId: businessProfile.id,
    customerPhone,
    channel,
    mediaInfo:         params.mediaInfo,
    conversationId,
  });
}
