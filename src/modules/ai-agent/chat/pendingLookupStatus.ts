import type { AiRoutingDecision } from "@modules/ai-agent/core/aiEngine.utils";

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
): Promise<AiRoutingDecision> {
  const text = buildDeterministicStatusText(params);

  return {
    action: "REPLY_AUTO",
    handoffCategory: null,
    reasoning: "Deterministic progress update for queued chat-requested action.",
    content: text,
    publicContent: text,
    privateContent: text,
    requiresGrounding: false,
    grounded: true,
    usedChunkTypes: [],
    missingInfo: null,
  };
}

function buildDeterministicStatusText(
  params: PendingLookupStatusParams,
): string {
  if (shouldUseArabic(params)) {
    return "تمام يا فندم، هراجع التفاصيل المتاحة وأرجع لحضرتك حالاً.";
  }

  return "Got it. I’m checking the details now and will follow up shortly.";
}

function shouldUseArabic(params: PendingLookupStatusParams): boolean {
  const text = [
    params.voice,
    params.tone,
    params.businessName,
    params.latestUserText,
  ]
    .filter(Boolean)
    .join(" ");

  return /arabic|egyptian|عربي|العربية|مصري|مصرى/i.test(text) || /[\u0600-\u06ff]/.test(text);
}
