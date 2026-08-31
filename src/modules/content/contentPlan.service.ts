import { AgentClient } from "@modules/ai-agent/client/agent.client";
import prisma from "@config/prisma";
import { AppError } from "@middlewares/errorHandler.middleware";
import { getContentBriefForStrategy } from "./contentBrief.service";
import { generateCopilotContentPlan } from "./contentCopilot.service";

export interface BriefingInput {
  businessProfileId: number;
  userId: number;
  contentBriefId?: number;
  startDate: string; // ISO format
  endDate: string; // ISO format
  goals?: string;
  currentTrends?: string | string[];
}

function normalizeOptionalText(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  return value;
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

// Extracts the generated draft from an AgentClient.runContentGeneration run
// result. The agent graph returns its final state; the capability draft lives
// under the "content_generation" key, with a fallback to the raw value.
function extractGenerationDraft(result: any) {
  return result?.content_generation ?? result ?? {};
}

export async function* generateContentStrategyStream(briefing: BriefingInput) {
  const profile = await prisma.businessProfile.findUnique({
    where: { id: briefing.businessProfileId },
  });

  if (!profile) {
    throw new AppError("Business profile not found", 404);
  }

  const contentBrief = await getContentBriefForStrategy({
    userId: briefing.userId,
    businessProfileId: briefing.businessProfileId,
    contentBriefId: briefing.contentBriefId,
  });

  yield {
    type: "status",
    message: "Generating your strategy via the agent service...",
  };

  const result = await AgentClient.runContentGeneration("plan", {
    business_profile_id: briefing.businessProfileId,
    user_id: briefing.userId,
    goal: briefing.goals,
    start_date: briefing.startDate,
    end_date: briefing.endDate,
    current_trends: normalizeOptionalText(briefing.currentTrends),
    platform: "facebook",
    settings: {
      name: profile.name,
      voice: profile.voice,
      tone: profile.tone,
    },
    brief: contentBrief
      ? {
          goal: contentBrief.goal,
          audienceSegments: contentBrief.audienceSegments,
          painPoints: contentBrief.painPoints,
          objections: contentBrief.objections,
          buyingTriggers: contentBrief.buyingTriggers,
          offers: contentBrief.offers,
          proofPoints: contentBrief.proofPoints,
          cta: contentBrief.cta,
          funnelFocus: contentBrief.funnelFocus,
          tonePreferences: contentBrief.tonePreferences,
          forbiddenTopics: contentBrief.forbiddenTopics,
        }
      : null,
  });

  const draft = extractGenerationDraft(result);

  const generated = await generateCopilotContentPlan({
    userId: briefing.userId,
    businessProfileId: briefing.businessProfileId,
    draft: {
      goals: draft.goals || (briefing.goals ? [briefing.goals] : []),
      posts: draft.posts || [],
    },
    goal: briefing.goals,
    platform: "facebook",
  });

  await prisma.contentPlan.update({
    where: { id: generated.planId },
    data: {
      contentBriefId: contentBrief?.id || null,
      startDate: new Date(briefing.startDate),
      endDate: new Date(briefing.endDate),
      currentTrends: normalizeOptionalText(briefing.currentTrends) || null,
      briefSnapshot: buildBriefSnapshot(contentBrief) || undefined,
    },
  });

  const plan = await prisma.contentPlan.findUnique({
    where: { id: generated.planId },
    include: { posts: { orderBy: { scheduledAt: "asc" } } },
  });

  yield { type: "result", data: plan };
}

export async function generatePostExecution(postId: number, userId: number) {
  const post = await prisma.contentPlanPost.findFirst({
    where: { id: postId, contentPlan: { userId } },
    include: { contentPlan: true },
  });
  if (!post) {
    throw new AppError("Post not found", 404);
  }

  const profile = await prisma.businessProfile.findUnique({
    where: { id: post.contentPlan.businessProfileId },
    select: { name: true, voice: true, tone: true },
  });

  const result = await AgentClient.runContentGeneration("post", {
    business_profile_id: post.contentPlan.businessProfileId,
    user_id: userId,
    topic: post.topic,
    pillar: post.pillar,
    platform: post.platform,
    funnel_stage: post.funnelStage,
    settings: profile || {},
  });

  const draft = extractGenerationDraft(result);
  const caption = draft.caption ?? draft.post?.caption;
  const imagePrompt = draft.image_prompt ?? draft.imagePrompt ?? draft.post?.image_prompt;
  if (!caption) {
    throw new AppError("Post content generation returned no caption", 502);
  }

  return prisma.contentPlanPost.update({
    where: { id: postId },
    data: {
      caption,
      imagePrompt: imagePrompt || null,
      status: "generated",
    },
  });
}
