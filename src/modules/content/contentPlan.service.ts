import { AgentClient } from "@modules/ai-agent/client/agent.client";
import { recordAiUsage, assertQuotaAvailable } from "../billing/billing.service";
import { logger } from "@utils/logger";
import { getContentBriefForStrategy } from "./contentBrief.service";
import prisma from "@config/prisma";
import { AppError } from "@middlewares/errorHandler.middleware";

export interface BriefingInput {
  businessProfileId: number;
  userId: number;
  contentBriefId?: number;
  startDate: string; // ISO format
  endDate: string; // ISO format
  goals?: string;
  currentTrends?: string | string[];
}

const SOCIAL_MEDIA_SPECIALIST_ROLE = `You are a senior social media specialist, market-aware content strategist, and brand copywriter. Your job is to turn business context into platform-native content that attracts attention, builds trust, and supports measurable campaign goals.`;

function formatJsonForPrompt(value: unknown): string {
  if (!value) return "Not specified";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeOptionalText(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  return value;
}

function buildVoiceToneGuard(
  profile: {
    voice?: string | null;
    tone?: string | null;
    aiBehaviorInstructions?: string | null;
    corePolicies?: string | null;
  },
  brief?: { tonePreferences?: string | null } | null,
) {
  const voice = profile.voice || "the business profile voice";
  const tone = profile.tone || "the business profile tone";

  return `
--- BUSINESS VOICE AND TONE RULES ---
- Primary language/dialect: ${voice}
- Business tone: ${tone}
${profile.aiBehaviorInstructions ? `- Additional writing instructions: ${profile.aiBehaviorInstructions}` : ""}
${profile.corePolicies ? `- Factual boundaries and policies: ${profile.corePolicies}` : ""}
${brief?.tonePreferences ? `- Campaign tone note (secondary): ${brief.tonePreferences}` : ""}
Rules:
1. The business profile voice and tone are the source of truth for all generated content.
2. Campaign tone notes, goals, research, trends, and user context may refine the angle, but must not override the profile voice, language, dialect, or tone.
3. Keep captions, topics, slide text, scripts, CTAs, hashtags, and review summaries in this voice and language unless the profile explicitly allows otherwise.
4. Do not invent claims, prices, guarantees, policies, statistics, or locations.
5. Avoid generic AI-style marketing phrasing; write like a real brand operator.
-------------------------------------
  `.trim();
}

function buildBriefContext(brief: any) {
  if (!brief) return "";

  return `
--- CONFIRMED SIGNAL-LED CONTENT BRIEF ---
- Goal: ${brief.goal || "Not specified"}
- Audience Segments: ${formatJsonForPrompt(brief.audienceSegments)}
- Pain Points: ${formatJsonForPrompt(brief.painPoints)}
- Objections / Buying Friction: ${formatJsonForPrompt(brief.objections)}
- Buying Triggers: ${formatJsonForPrompt(brief.buyingTriggers)}
- Offers / Services to Prioritize: ${formatJsonForPrompt(brief.offers)}
- Proof Points: ${formatJsonForPrompt(brief.proofPoints)}
- CTA: ${brief.cta || "Not specified"}
- Funnel Focus: ${brief.funnelFocus || "mixed"}
- Campaign Tone Preferences (secondary only; must stay compatible with business profile voice/tone): ${brief.tonePreferences || "Use the business profile voice and tone"}
- Forbidden Topics: ${formatJsonForPrompt(brief.forbiddenTopics)}
- Competitor Insights: ${formatJsonForPrompt(brief.competitorInsights)}
------------------------------------------
  `.trim();
}

function buildBriefSnapshot(brief: any) {
  if (!brief) return null;
  return {
    id: brief.id,
    sourceAuditId: brief.sourceAuditId,
    goal: brief.goal,
    audienceSegments: brief.audienceSegments,
    painPoints: brief.painPoints,
    objections: brief.objections,
    buyingTriggers: brief.buyingTriggers,
    offers: brief.offers,
    proofPoints: brief.proofPoints,
    cta: brief.cta,
    funnelFocus: brief.funnelFocus,
    tonePreferences: brief.tonePreferences,
    forbiddenTopics: brief.forbiddenTopics,
    competitorInsights: brief.competitorInsights,
  };
}

function contentPlanPostData(item: any) {
  return {
    scheduledAt: new Date(item.scheduledAt),
    platform: item.platform,
    pillar: item.pillar,
    topic: item.topic,
    format: item.format,
    funnelStage: item.funnelStage || null,
    contentGoal: item.contentGoal || null,
    targetPainPoint: item.targetPainPoint || null,
    objectionHandled: item.objectionHandled || null,
    cta: item.cta || null,
    rationale: item.rationale || null,
    evidenceRefs: item.evidenceRefs || [],
    status: "pending",
  };
}

export async function* generateContentStrategyStream(briefing: BriefingInput) {
  const profile = await prisma.businessProfile.findUnique({
    where: { id: briefing.businessProfileId },
  });

  if (!profile) {
    throw new AppError("Business profile not found", 404);
  }

  // Content-plan AI generation (RAG + pipeline) moved to the sibling agent-svc
  // microservice in the ai-agent cutover. Surface a clear status so callers see
  // a single, consistent event before the generator ends.
  yield {
    type: "status",
    message:
      "Content strategy generation moved to agent-svc microservice; this stream is disabled.",
  };
  yield {
    type: "error",
    message:
      "content_plan_strategy moved to agent-svc microservice; this path is disabled.",
  };
}

export async function generateContentStrategy(briefing: BriefingInput) {
  return AgentClient.runCopilot({
    business_profile_id: briefing.businessProfileId,
    user_id: briefing.userId,
    messages: [],
    stage: "fast",
  } as any) as any;
}

export async function generatePostExecution(postId: number, userId: number) {
  // Post-execution AI generation (RAG + pipeline) moved to the sibling agent-svc
  // microservice in the ai-agent cutover. Reset the post to pending and surface
  // a clear error so callers can retry once the agent-svc endpoint is wired.
  const post = await prisma.contentPlanPost.findUnique({
    where: { id: postId },
    select: { id: true },
  });
  if (post) {
    await prisma.contentPlanPost.update({
      where: { id: postId },
      data: { status: "pending" },
    });
  }
  void postId;
  void userId;
  throw new AppError(
    "Post execution AI moved to agent-svc microservice; this path is disabled.",
    503,
  );
}
