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

function buildStrategyKnowledge(brief: any, currentTrends?: string) {
  const knowledge: Array<Record<string, unknown>> = [];
  if (currentTrends) {
    knowledge.push({ source: "current_trends", content: currentTrends });
  }
  const snapshot = buildBriefSnapshot(brief);
  if (snapshot) {
    knowledge.push({ source: "content_brief", content: snapshot });
  }
  return knowledge;
}

export async function* generateContentStrategyStream(briefing: BriefingInput) {
  const profile = await prisma.businessProfile.findFirst({
    where: { id: briefing.businessProfileId, userId: briefing.userId },
  });

  if (!profile) {
    throw new AppError("Business profile not found", 404);
  }

  const contentBrief = await getContentBriefForStrategy({
    userId: briefing.userId,
    businessProfileId: briefing.businessProfileId,
    contentBriefId: briefing.contentBriefId,
  });
  const goal = briefing.goals?.trim() || contentBrief?.goal?.trim();
  if (!goal) {
    throw new AppError("A content strategy goal is required", 400);
  }
  const currentTrends = normalizeOptionalText(briefing.currentTrends);

  yield {
    type: "status",
    message: "Generating your strategy via the agent service...",
  };

  const draft = await AgentClient.runCapability({
    userId: briefing.userId,
    businessProfileId: briefing.businessProfileId,
    operation: "content_plan",
    context: {
      goal,
      startDate: briefing.startDate,
      endDate: briefing.endDate,
      platform: "facebook",
      settings: {
        name: profile.name,
        voice: profile.voice,
        tone: profile.tone,
        corePolicies: profile.corePolicies,
        aiBehaviorInstructions: profile.aiBehaviorInstructions,
      },
      knowledge: buildStrategyKnowledge(contentBrief, currentTrends),
    },
  });

  const generated = await generateCopilotContentPlan({
    userId: briefing.userId,
    businessProfileId: briefing.businessProfileId,
    draft: {
      goals: draft.goals,
      posts: draft.posts,
    },
    goal,
    platform: "facebook",
  });

  await prisma.contentPlan.update({
    where: { id: generated.planId },
    data: {
      contentBriefId: contentBrief?.id || null,
      startDate: new Date(briefing.startDate),
      endDate: new Date(briefing.endDate),
      currentTrends: currentTrends || null,
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

  const result = await AgentClient.runCapability({
    userId,
    businessProfileId: post.contentPlan.businessProfileId,
    operation: "content_post",
    context: {
      topic: post.topic,
      post: {
        scheduledAt: post.scheduledAt.toISOString(),
        platform: post.platform,
        pillar: post.pillar,
        topic: post.topic,
        format: post.format,
        funnelStage: post.funnelStage,
        contentGoal: post.contentGoal,
        targetPainPoint: post.targetPainPoint,
        objectionHandled: post.objectionHandled,
        cta: post.cta,
        rationale: post.rationale,
        evidenceRefs: post.evidenceRefs,
      },
      business: profile || {},
      plan: {
        startDate: post.contentPlan.startDate.toISOString(),
        endDate: post.contentPlan.endDate.toISOString(),
        goals: post.contentPlan.goals,
        currentTrends: post.contentPlan.currentTrends,
        briefSnapshot: post.contentPlan.briefSnapshot,
      },
    },
  });

  const caption = result.caption;
  const imagePrompt = result.image_prompt || result.suggested_image;
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
