import { Type } from "@google/genai";
import {
  executeWithFallback,
  genAI,
  MESSENGER_SAFETY_SETTINGS,
} from "@modules/ai-agent/gemini";
import { repairAndParseAiResponse } from "@modules/ai-agent/core/aiEngine.utils";
import { logger } from "@utils/logger";
import type { AiRoutingDecision } from "@modules/ai-agent/core/aiEngine.utils";
import {
  formatChannelStyleRules,
  getChannelPromptProfile,
} from "@modules/meta/core/prompt.service";

const PENDING_LOOKUP_STATUS_TIMEOUT_MS = 1_500;
const PENDING_LOOKUP_MODEL_TIERS = [
  "gemini-3.1-flash-lite-preview",
  "gemini-2.5-flash",
];
const MAX_CONTEXT_TURNS = 3;
const MAX_CONTEXT_TURN_CHARS = 220;

export type PendingLookupStatusParams = {
  businessName: string;
  voice?: string | null;
  tone?: string | null;
  channel?: string | null;
  latestUserText: string;
  recentTurns?: Array<{
    role: "user" | "model";
    text: string;
  }>;
  source?: {
    name?: string | null;
    description?: string | null;
  } | null;
};

export async function generatePendingLookupStatusDecision(
  params: PendingLookupStatusParams,
): Promise<AiRoutingDecision | null> {
  try {
    const decision = await Promise.race([
      generatePendingLookupStatusDecisionUnsafe(params),
      new Promise<null>((resolve) =>
        setTimeout(resolve, PENDING_LOOKUP_STATUS_TIMEOUT_MS),
      ),
    ]);

    if (!decision) {
      logger.warn("ai.pending_lookup_status.timeout_or_empty", {
        businessName: params.businessName,
        channel: params.channel,
        sourceName: params.source?.name,
      });
      return null;
    }

    return normalizePendingLookupDecision(decision, params.channel);
  } catch (error: any) {
    logger.warn("ai.pending_lookup_status.failed", {
      businessName: params.businessName,
      channel: params.channel,
      sourceName: params.source?.name,
      error: error?.message || String(error),
    });
    return null;
  }
}

async function generatePendingLookupStatusDecisionUnsafe(
  params: PendingLookupStatusParams,
): Promise<AiRoutingDecision | null> {
  const channel = params.channel || "messenger";
  const channelProfile = getChannelPromptProfile(channel);
  const recentContext = formatRecentTurns(params.recentTurns ?? []);
  const prompt = [
    `You write a single short customer-facing progress update for ${params.businessName}.`,
    "",
    "<context>",
    `Business voice/language: ${params.voice || "Professional"}`,
    `Tone: ${params.tone || "Friendly"}`,
    `Reply field: ${channelProfile.statusTarget}`,
    `Customer latest message: ${params.latestUserText || ""}`,
    recentContext ? `Recent chat context:\n${recentContext}` : "",
    `Queued action: ${params.source?.name || "business action"}`,
    params.source?.description
      ? `Action description: ${params.source.description}`
      : "",
    "</context>",
    "",
    "Rules:",
    "- Return JSON only.",
    "- This is only a progress update while a queued customer-requested action runs.",
    "- Do not answer the customer's factual question yet.",
    "- Do not mention queues, tools, APIs, systems, providers, or background jobs.",
    "- Do not claim anything is confirmed, available, booked, saved, priced, delivered, completed, or guaranteed.",
    "- Do not ask for details unless the customer already asked an unrelated question.",
    "- Match the customer's/business language and tone.",
    "",
    channelProfile.styleTag === "facebook_comment_style"
      ? "facebook_comment_style:"
      : "direct_chat_style:",
    formatChannelStyleRules(channel, "status"),
  ]
    .filter(Boolean)
    .join("\n");

  const { result } = await executeWithFallback(
    async (model) => {
      return genAI.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          temperature: 0.3,
          maxOutputTokens: 180,
          safetySettings: MESSENGER_SAFETY_SETTINGS,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              content: {
                type: Type.STRING,
                description: "The short progress update for direct chat.",
              },
              publicContent: {
                type: Type.STRING,
                description: "The short public-comment progress update.",
              },
              privateContent: {
                type: Type.STRING,
                description: "The short private-message progress update.",
              },
              reasoning: {
                type: Type.STRING,
                description: "Brief internal reason for the wording.",
              },
            },
            required: ["content", "reasoning"],
          },
        },
      });
    },
    "PendingLookupStatus",
    undefined,
    PENDING_LOOKUP_MODEL_TIERS,
  );

  const parsed = repairAndParseAiResponse(result.text || "{}");
  if (!hasAnyStatusText(parsed)) return null;
  return parsed;
}

function formatRecentTurns(
  turns: Array<{ role: "user" | "model"; text: string }>,
): string {
  return turns
    .slice(-MAX_CONTEXT_TURNS)
    .map((turn) => {
      const text = turn.text.replace(/\s+/g, " ").trim();
      if (!text) return null;
      const clipped =
        text.length > MAX_CONTEXT_TURN_CHARS
          ? `${text.slice(0, MAX_CONTEXT_TURN_CHARS).trim()}...`
          : text;
      return `${turn.role}: ${clipped}`;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function normalizePendingLookupDecision(
  decision: AiRoutingDecision,
  channel?: string | null,
): AiRoutingDecision | null {
  const primary =
    channel === "facebook_comment"
      ? decision.publicContent || decision.content || decision.privateContent
      : decision.content || decision.privateContent || decision.publicContent;
  const text = sanitizeStatusText(primary || "");
  if (!text) return null;

  return {
    action: "REPLY_AUTO",
    handoffCategory: null,
    reasoning:
      decision.reasoning ||
      "Generated contextual progress update for queued chat-requested action.",
    content: text,
    publicContent: sanitizeStatusText(decision.publicContent || text) || text,
    privateContent: sanitizeStatusText(decision.privateContent || text) || text,
    requiresGrounding: false,
    grounded: true,
    usedChunkTypes: [],
    missingInfo: null,
  };
}

function hasAnyStatusText(decision: AiRoutingDecision): boolean {
  return Boolean(
    decision.content?.trim() ||
      decision.publicContent?.trim() ||
      decision.privateContent?.trim(),
  );
}

function sanitizeStatusText(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  return trimmed.length > 240 ? `${trimmed.slice(0, 237).trim()}...` : trimmed;
}
