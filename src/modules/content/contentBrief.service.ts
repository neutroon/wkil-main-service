import { AgentClient } from "@modules/ai-agent/client/agent.client";
import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { AppError } from "@middlewares/errorHandler.middleware";
import { assertQuotaAvailable } from "../billing/billing.service";
import {
  getPagePosts,
  getPostComments,
} from "../meta/facebook/facebook.service";

type CompetitorDiscoveryScope =
  | "PROVIDED_ONLY"
  | "PROVIDED_AND_AI_SEARCH"
  | "AI_DISCOVERY";

type CompetitorAnalysisMode =
  | "WEBSITE_SEARCH"
  | "SOCIAL_SAMPLES"
  | "PUBLIC_SOCIAL_SCRAPE";

export interface ContentAuditInput {
  businessProfileId: number;
  userId: number;
  startDate?: string;
  endDate?: string;
  goal?: string;
  currentTrends?: string;
  signalWindowDays?: number;
  competitorDiscoveryScope?: CompetitorDiscoveryScope;
  competitorAnalysisModes?: CompetitorAnalysisMode[];
  competitors?: Array<{ name?: string; url?: string }>;
  socialSamples?: Array<{
    competitorName?: string;
    platform?: string;
    url?: string;
    text?: string;
  }>;
}

type EvidenceRef = {
  id: string;
  sourceType: string;
  label: string;
  createdAt?: string;
  url?: string;
};

type SignalBundle = {
  summary: {
    signalWindowDays: number;
    messageCount: number;
    commentThreadCount: number;
    customerCount: number;
    previousPlanCount: number;
    livePostCount: number;
    liveCommentCount: number;
  };
  evidenceRefs: EvidenceRef[];
  audienceSignals: string[];
  customerQuestionSignals: string[];
  commentSignals: string[];
  customerSignals: string[];
  contentSignals: string[];
  liveSocialSignals: string[];
};

function asArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function trimForPrompt(text: string | null | undefined, max = 280) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > max
    ? `${normalized.slice(0, max - 1)}...`
    : normalized;
}

async function getOwnedProfile(businessProfileId: number, userId: number) {
  const profile = await prisma.businessProfile.findFirst({
    where: { id: businessProfileId, userId },
    include: {
      facebookPages: {
        where: { isActive: true, isTokenValid: true },
        select: {
          id: true,
          pageId: true,
          pageName: true,
          category: true,
          followersCount: true,
        },
      },
    },
  });

  if (!profile) {
    throw new AppError("Business profile not found", 404);
  }

  return profile;
}

export async function collectFirstPartySignals(params: {
  businessProfileId: number;
  userId: number;
  signalWindowDays: number;
}): Promise<SignalBundle> {
  const since = new Date();
  since.setDate(since.getDate() - params.signalWindowDays);

  const [messages, commentThreads, customers, previousPlans, profile] =
    await Promise.all([
      prisma.conversationMessage.findMany({
        where: {
          role: "user",
          type: "text",
          createdAt: { gte: since },
          conversation: {
            businessProfileId: params.businessProfileId,
            businessProfile: { userId: params.userId },
          },
        },
        select: {
          id: true,
          content: true,
          createdAt: true,
          intent: true,
          handoffCategory: true,
          conversation: {
            select: {
              channel: true,
              postId: true,
              sourceCommentText: true,
              customerName: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        take: 80,
      }),
      prisma.conversation.findMany({
        where: {
          businessProfileId: params.businessProfileId,
          businessProfile: { userId: params.userId },
          channel: "facebook_comment",
          updatedAt: { gte: since },
        },
        select: {
          id: true,
          postId: true,
          sourceCommentText: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
        take: 50,
      }),
      prisma.customer.findMany({
        where: {
          businessProfileId: params.businessProfileId,
          businessProfile: { userId: params.userId },
          lastInteractionAt: { gte: since },
        },
        select: {
          id: true,
          primaryChannel: true,
          status: true,
          capturedFields: true,
          lastInteractionAt: true,
        },
        orderBy: { lastInteractionAt: "desc" },
        take: 60,
      }),
      prisma.contentPlan.findMany({
        where: {
          businessProfileId: params.businessProfileId,
          userId: params.userId,
          createdAt: { gte: since },
        },
        select: {
          id: true,
          goals: true,
          researchSummary: true,
          createdAt: true,
          posts: {
            select: {
              id: true,
              pillar: true,
              topic: true,
              status: true,
              caption: true,
            },
            orderBy: { scheduledAt: "desc" },
            take: 8,
          },
        },
        orderBy: { createdAt: "desc" },
        take: 6,
      }),
      prisma.businessProfile.findFirst({
        where: { id: params.businessProfileId, userId: params.userId },
        select: {
          facebookPages: {
            where: { isActive: true, isTokenValid: true },
            select: {
              pageId: true,
              pageName: true,
              followersCount: true,
            },
            take: 3,
          },
        },
      }),
    ]);

  const evidenceRefs: EvidenceRef[] = [];
  const customerQuestionSignals = messages.map((message) => {
    evidenceRefs.push({
      id: `message:${message.id}`,
      sourceType: message.conversation.channel || "inbox",
      label: `${message.conversation.channel || "Inbox"} message`,
      createdAt: message.createdAt.toISOString(),
    });
    return [
      `source=message:${message.id}`,
      `channel=${message.conversation.channel || "unknown"}`,
      message.intent ? `intent=${message.intent}` : "",
      message.handoffCategory ? `handoff=${message.handoffCategory}` : "",
      `customer_text="${trimForPrompt(message.content)}"`,
    ]
      .filter(Boolean)
      .join(" | ");
  });

  const commentSignals = commentThreads
    .filter((thread) => thread.sourceCommentText)
    .map((thread) => {
      evidenceRefs.push({
        id: `comment-thread:${thread.id}`,
        sourceType: "facebook_comment",
        label: `Facebook comment thread${thread.postId ? ` on ${thread.postId}` : ""}`,
        createdAt: thread.updatedAt.toISOString(),
      });
      return `source=comment-thread:${thread.id} | post=${thread.postId || "unknown"} | comment="${trimForPrompt(thread.sourceCommentText)}"`;
    });

  const customerSignals = customers.map((customer) => {
    evidenceRefs.push({
      id: `customer:${customer.id}`,
      sourceType: customer.primaryChannel || "customer",
      label: `${customer.primaryChannel || "Customer"} record`,
      createdAt: customer.lastInteractionAt.toISOString(),
    });
    return [
      `source=customer:${customer.id}`,
      `channel=${customer.primaryChannel || "unknown"}`,
      `status=${customer.status}`,
      `captured_fields=${JSON.stringify(customer.capturedFields || {})}`,
    ].join(" | ");
  });

  const contentSignals = previousPlans.flatMap((plan) => {
    evidenceRefs.push({
      id: `content-plan:${plan.id}`,
      sourceType: "content_plan",
      label: "Previous content plan",
      createdAt: plan.createdAt.toISOString(),
    });
    return plan.posts.map(
      (post) =>
        `source=content-post:${post.id} | pillar=${post.pillar} | status=${post.status} | topic="${trimForPrompt(post.topic, 180)}" | caption="${trimForPrompt(post.caption, 220)}"`,
    );
  });

  const liveSocialSignals: string[] = [];
  for (const page of profile?.facebookPages || []) {
    try {
      const posts = await getPagePosts(page.pageId);
      const postSamples = asArray(posts?.data || posts).slice(0, 5);
      postSamples.forEach((post: any) => {
        if (!post?.id) return;
        evidenceRefs.push({
          id: `facebook-post:${post.id}`,
          sourceType: "facebook_post",
          label: `Facebook page post on ${page.pageName}`,
          createdAt: post.created_time,
          url: post.permalink_url,
        });
        liveSocialSignals.push(
          `source=facebook-post:${post.id} | page=${page.pageName} | message="${trimForPrompt(post.message, 240)}" | created=${post.created_time || "unknown"}`,
        );
      });

      for (const post of postSamples.slice(0, 3)) {
        if (!post?.id) continue;
        try {
          const comments = await getPostComments(post.id);
          asArray(comments?.data).slice(0, 8).forEach((comment: any) => {
            if (!comment?.id || !comment?.message) return;
            evidenceRefs.push({
              id: `facebook-comment:${comment.id}`,
              sourceType: "facebook_comment",
              label: `Public comment on ${page.pageName}`,
              createdAt: comment.created_time,
            });
            liveSocialSignals.push(
              `source=facebook-comment:${comment.id} | post=${post.id} | likes=${comment.like_count || 0} | comment="${trimForPrompt(comment.message, 220)}"`,
            );
          });
        } catch (err) {
          logger.warn("content_audit.live_comments_failed", {
            pageId: page.pageId,
            postId: post.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      logger.warn("content_audit.live_posts_failed", {
        pageId: page.pageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    summary: {
      signalWindowDays: params.signalWindowDays,
      messageCount: messages.length,
      commentThreadCount: commentThreads.length,
      customerCount: customers.length,
      previousPlanCount: previousPlans.length,
      livePostCount: liveSocialSignals.filter((s) =>
        s.includes("facebook-post:"),
      ).length,
      liveCommentCount: liveSocialSignals.filter((s) =>
        s.includes("facebook-comment:"),
      ).length,
    },
    evidenceRefs: evidenceRefs.slice(0, 180),
    audienceSignals: [
      ...customerQuestionSignals.slice(0, 30),
      ...commentSignals.slice(0, 20),
    ],
    customerQuestionSignals: customerQuestionSignals.slice(0, 60),
    commentSignals: commentSignals.slice(0, 35),
    customerSignals: customerSignals.slice(0, 50),
    contentSignals: contentSignals.slice(0, 40),
    liveSocialSignals: liveSocialSignals.slice(0, 60),
  };
}

async function collectCompetitorSignals(params: {
  auditId: number;
  profile: any;
  input: ContentAuditInput;
}) {
  const modes = params.input.competitorAnalysisModes || ["WEBSITE_SEARCH"];

  const sources: any[] = [];
  if (modes.includes("SOCIAL_SAMPLES")) {
    for (const sample of (params.input.socialSamples || []).slice(0, 20)) {
      const source = await prisma.competitorSource.create({
        data: {
          businessProfileId: params.profile.id,
          contentAuditId: params.auditId,
          name: sample.competitorName || null,
          url: sample.url || null,
          mode: "SOCIAL_SAMPLES",
          sourceType: "social_sample",
          status: "completed",
          summary: {
            platform: sample.platform,
            sampleSummary: trimForPrompt(sample.text || sample.url, 800),
            opportunities: [],
          },
          evidenceRefs: [
            {
              id: `competitor-social-sample:${sample.url || sample.competitorName || "manual"}`,
              sourceType: "social_sample",
              label: `${sample.platform || "Social"} sample from ${sample.competitorName || "competitor"}`,
              url: sample.url,
            },
          ],
        },
      });
      sources.push(source);
    }
  }

  return sources;
}

// snake_case -> camelCase (the agent-svc capability drafts use snake_case keys)
function toCamel(value: any): any {
  if (Array.isArray(value)) return value.map(toCamel);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
        toCamel(v),
      ]),
    );
  }
  return value;
}

// The capability returns string findings / gap questions; the wizard renders
// objects ({ title } / { id, question }). Map minimally so it keeps working.
function normalizeAuditDraft(draft: any) {
  const raw = draft || {};
  const findings = (raw.findings || []).map((f: any) =>
    typeof f === "string" ? { title: f } : f,
  );
  const gapQuestions = (raw.gap_questions || raw.gapQuestions || []).map(
    (q: any, i: number) =>
      typeof q === "string" ? { id: `gap_${i + 1}`, question: q } : q,
  );
  const draftBrief = toCamel(raw.draft_brief || raw.draftBrief || {});
  const confidenceScore = Number(raw.confidence_score ?? raw.confidenceScore ?? 0);
  return { findings, gapQuestions, draftBrief, confidenceScore };
}

export async function* generateContentAuditStream(input: ContentAuditInput) {
  const signalWindowDays = input.signalWindowDays || 90;
  const profile = await getOwnedProfile(input.businessProfileId, input.userId);
  await assertQuotaAvailable(input.userId, input.businessProfileId);

  const audit = await prisma.contentAudit.create({
    data: {
      businessProfileId: input.businessProfileId,
      userId: input.userId,
      signalWindowDays,
      competitorDiscoveryScope:
        input.competitorDiscoveryScope || "PROVIDED_AND_AI_SEARCH",
      competitorAnalysisModes: input.competitorAnalysisModes || [
        "WEBSITE_SEARCH",
      ],
      campaignGoal: input.goal || null,
      startDate: input.startDate ? new Date(input.startDate) : null,
      endDate: input.endDate ? new Date(input.endDate) : null,
      status: "running",
    },
  });

  try {
    yield {
      type: "status",
      message: "Collecting first-party customer, comment, and content signals...",
      auditId: audit.id,
    };
    const firstParty = await collectFirstPartySignals({
      businessProfileId: input.businessProfileId,
      userId: input.userId,
      signalWindowDays,
    });

    yield {
      type: "status",
      message: "Analyzing competitor positioning and market gaps...",
      auditId: audit.id,
    };
    const competitorSources = await collectCompetitorSignals({
      auditId: audit.id,
      profile,
      input,
    });

    yield {
      type: "status",
      message: "Drafting signal-led content brief via the agent service...",
      auditId: audit.id,
    };

    const result = await AgentClient.runContentGeneration("audit", {
      business_profile_id: input.businessProfileId,
      user_id: input.userId,
      goal: input.goal,
      start_date: input.startDate,
      end_date: input.endDate,
      current_trends: input.currentTrends,
      settings: {
        name: profile.name,
        voice: profile.voice,
        tone: profile.tone,
      },
      signals: firstParty,
    });
    const draft = normalizeAuditDraft(result?.content_generation ?? result);

    const updatedAudit = await prisma.contentAudit.update({
      where: { id: audit.id },
      data: {
        status: "completed",
        findings: draft.findings,
        gapQuestions: draft.gapQuestions,
        draftBrief: draft.draftBrief,
        evidenceRefs: firstParty.evidenceRefs,
        confidenceScore: draft.confidenceScore,
      },
      include: {
        competitorSources: true,
      },
    });

    yield {
      type: "result",
      data: {
        audit: updatedAudit,
        findings: draft.findings,
        gapQuestions: draft.gapQuestions,
        draftBrief: draft.draftBrief,
        evidenceRefs: firstParty.evidenceRefs,
        competitorSources: updatedAudit.competitorSources,
      },
    };
  } catch (err: any) {
    await prisma.contentAudit.update({
      where: { id: audit.id },
      data: {
        status: "failed",
        errorMessage: err.message || String(err),
      },
    });
    throw err;
  }
}
export async function saveContentBrief(userId: number, data: any) {
  const profile = await getOwnedProfile(Number(data.businessProfileId), userId);

  if (data.sourceAuditId) {
    const audit = await prisma.contentAudit.findFirst({
      where: {
        id: Number(data.sourceAuditId),
        businessProfileId: profile.id,
        userId,
      },
    });
    if (!audit) {
      throw new AppError("Content audit not found", 404);
    }
  }

  return prisma.contentBrief.create({
    data: {
      businessProfileId: profile.id,
      userId,
      sourceAuditId: data.sourceAuditId ? Number(data.sourceAuditId) : null,
      status: data.status || "confirmed",
      goal: data.goal || null,
      audienceSegments: data.audienceSegments || [],
      painPoints: data.painPoints || [],
      objections: data.objections || [],
      buyingTriggers: data.buyingTriggers || [],
      offers: data.offers || [],
      proofPoints: data.proofPoints || [],
      cta: data.cta || null,
      funnelFocus: data.funnelFocus || null,
      tonePreferences: data.tonePreferences || null,
      forbiddenTopics: data.forbiddenTopics || [],
      competitorInsights: data.competitorInsights || {},
      ownerAnswers: data.ownerAnswers || {},
    },
    include: {
      sourceAudit: true,
    },
  });
}

export async function getContentBrief(userId: number, id: number) {
  const brief = await prisma.contentBrief.findFirst({
    where: {
      id,
      businessProfile: { userId },
    },
    include: {
      sourceAudit: true,
    },
  });

  if (!brief) {
    throw new AppError("Content brief not found", 404);
  }

  return brief;
}

export async function getContentBriefForStrategy(params: {
  userId: number;
  businessProfileId: number;
  contentBriefId?: number;
}) {
  if (!params.contentBriefId) return null;

  const brief = await prisma.contentBrief.findFirst({
    where: {
      id: params.contentBriefId,
      businessProfileId: params.businessProfileId,
      userId: params.userId,
    },
    include: {
      sourceAudit: true,
    },
  });

  if (!brief) {
    throw new AppError("Content brief not found", 404);
  }

  return brief;
}
