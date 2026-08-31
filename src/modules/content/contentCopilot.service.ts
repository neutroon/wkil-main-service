import prisma from "@config/prisma";
import { getAccessibleProfileIds } from "@modules/auth/user/user.service";
import { socialQueue } from "./social.queue";
import { AppError } from "@middlewares/errorHandler.middleware";

export interface CopilotPlanDraftPost {
  scheduled_at: string;
  pillar: string;
  topic: string;
  format: string;
  funnel_stage?: string;
  content_goal?: string;
  cta?: string;
  rationale?: string;
  caption?: string;
  image_prompt?: string;
}

export interface CopilotPlanDraft {
  goals?: string[];
  posts: CopilotPlanDraftPost[];
}

function mapDraftPost(post: CopilotPlanDraftPost, platform: string) {
  return {
    scheduledAt: new Date(post.scheduled_at),
    platform,
    pillar: post.pillar,
    topic: post.topic,
    format: post.format,
    funnelStage: post.funnel_stage || null,
    contentGoal: post.content_goal || null,
    cta: post.cta || null,
    rationale: post.rationale || null,
    caption: post.caption || null,
    imagePrompt: post.image_prompt || null,
    status: "pending",
  };
}

export async function listCopilotContentPlans(params: {
  userId: number;
  businessProfileId?: number;
  status?: string;
  limit?: number;
}) {
  const profileIds = await getAccessibleProfileIds(params.userId);
  const scoped = params.businessProfileId
    ? profileIds.filter((id: number) => id === params.businessProfileId)
    : profileIds;
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
  const plans = await prisma.contentPlan.findMany({
    where: {
      businessProfileId: { in: scoped },
      ...(params.status ? { status: params.status } : {}),
    },
    include: {
      posts: { orderBy: { scheduledAt: "asc" } },
      businessProfile: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return {
    plans,
    meta: { total: plans.length, limit, cite: { tool: "list_content_plans", fetchedAt: new Date().toISOString(), deepLink: "/content-library" } },
  };
}

export async function getCopilotContentPlan(params: {
  userId: number;
  planId: number;
}) {
  const plan = await prisma.contentPlan.findFirst({
    where: { id: params.planId, userId: params.userId },
    include: {
      posts: { orderBy: { scheduledAt: "asc" } },
      contentBrief: true,
      businessProfile: { select: { id: true, name: true, voice: true, tone: true } },
    },
  });
  if (!plan) {
    throw new AppError("Content plan not found", 404);
  }
  return plan;
}

export async function generateCopilotContentPlan(params: {
  userId: number;
  businessProfileId: number;
  draft: CopilotPlanDraft;
  goal?: string;
  platform?: string;
}) {
  const platform = params.platform || "facebook";
  const posts = params.draft.posts || [];
  const scheduledTimes = posts.map((p) => new Date(p.scheduled_at).getTime());
  const validTimes = scheduledTimes.filter((t) => !Number.isNaN(t));
  const startDate = validTimes.length ? new Date(Math.min(...validTimes)) : new Date();
  const endDate = validTimes.length ? new Date(Math.max(...validTimes)) : new Date();

  const plan = await prisma.contentPlan.create({
    data: {
      businessProfileId: params.businessProfileId,
      userId: params.userId,
      startDate,
      endDate,
      goals: params.goal || (params.draft.goals || []).join(", ") || null,
      status: "draft",
      posts: {
        create: posts.map((post) => mapDraftPost(post, platform)),
      },
    },
    include: { posts: true },
  });

  return {
    planId: plan.id,
    plan,
    envelopes: [
      {
        type: "content-plan",
        planId: plan.id,
        goal: params.goal || null,
        total: posts.length,
        posts: posts.map((p) => ({ topic: p.topic, scheduledAt: p.scheduled_at })),
        cite: { tool: "generate_content_plan", fetchedAt: new Date().toISOString(), deepLink: "/content-library" },
      },
    ],
  };
}

export async function generateCopilotPostContent(params: {
  userId: number;
  postId: number;
  caption: string;
  imagePrompt?: string;
}) {
  const post = await prisma.contentPlanPost.findFirst({
    where: { id: params.postId, contentPlan: { userId: params.userId } },
  });
  if (!post) {
    throw new AppError("Post not found", 404);
  }
  const updated = await prisma.contentPlanPost.update({
    where: { id: params.postId },
    data: {
      caption: params.caption,
      imagePrompt: params.imagePrompt ?? null,
      status: "generated",
    },
  });
  return { ok: true as const, post: updated };
}

export async function approveContentPost(params: {
  userId: number;
  postId: number;
  manual?: boolean;
}) {
  const post = await prisma.contentPlanPost.findFirst({
    where: { id: params.postId },
    include: { contentPlan: true },
  });

  if (!post || post.contentPlan.userId !== params.userId) {
    throw new AppError("Unauthorized or post not found", 403);
  }

  const updated = await prisma.contentPlanPost.update({
    where: { id: params.postId },
    data: { status: params.manual ? "approved_manual" : "approved" },
    include: { contentPlan: true },
  });

  if (!params.manual) {
    const delay = Math.max(
      0,
      new Date(updated.scheduledAt).getTime() - Date.now(),
    );

    await socialQueue.add(
      `publish-${updated.id}`,
      {
        postId: updated.id,
        platform: updated.platform,
        businessProfileId: updated.contentPlan?.businessProfileId,
      },
      { delay, jobId: `post-${updated.id}` },
    );
  }

  return { ok: true as const, post: updated };
}

export async function deleteCopilotContentPlan(params: {
  userId: number;
  planId: number;
}) {
  const plan = await prisma.contentPlan.findFirst({
    where: { id: params.planId, userId: params.userId },
    select: { id: true },
  });
  if (!plan) {
    throw new AppError("Content plan not found", 404);
  }
  await prisma.contentPlan.delete({ where: { id: params.planId } });
  return { ok: true as const };
}
