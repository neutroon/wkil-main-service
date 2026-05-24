import prisma from "@config/prisma";
import { env } from "@config/env";
import { internalClient } from "@utils/apiClient";
import { logger } from "@utils/logger";
import { AppError } from "@middlewares/errorHandler.middleware";
import { generateContent } from "@modules/ai-agent/gemini";
import { assertQuotaAvailable, recordAiUsage } from "../billing/billing.service";
import {
  getPagePosts,
  getPostComments,
} from "../meta/facebook/facebook.service";

const SCRAPING_SERVICE_URL =
  env.SCRAPING_SERVICE_URL || "https://scraper.pagespilot.com/api/scrape";

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

function stripJsonFences(text: string) {
  return text.replace(/```json/g, "").replace(/```/g, "").trim();
}

function parseJsonObject(text: string) {
  const cleanText = stripJsonFences(text);
  try {
    return JSON.parse(cleanText);
  } catch {
    const match = cleanText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON object found");
    return JSON.parse(match[0]);
  }
}

function trimForPrompt(text: string | null | undefined, max = 280) {
  const normalized = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > max
    ? `${normalized.slice(0, max - 1)}...`
    : normalized;
}

function uniqueCompetitors(
  competitors: Array<{ name?: string; url?: string }>,
) {
  const seen = new Set<string>();
  return competitors
    .map((c) => ({
      name: trimForPrompt(c.name, 120),
      url: c.url?.trim(),
    }))
    .filter((c) => c.name || c.url)
    .filter((c) => {
      const key = (c.url || c.name || "").toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 10);
}

async function getOwnedProfile(businessProfileId: number, userId: number) {
  const profile = await prisma.businessProfile.findFirst({
    where: { id: businessProfileId, userId },
    include: {
      faqs: true,
      knowledgeSections: true,
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

async function scrapeUrl(url: string) {
  const response = await internalClient.post(SCRAPING_SERVICE_URL, { url });
  return response.data?.content?.markdown || "";
}

async function discoverCompetitorsWithSearch(params: {
  profile: any;
  goal?: string;
}) {
  const prompt = `Use Google Search to identify 3 likely public competitors or alternatives for this business.

Business:
- Name: ${params.profile.name}
- Identity: ${params.profile.identity}
- Target audience: ${params.profile.targetAudience}
- Products/services: ${params.profile.productsServices.join(", ")}
- Campaign goal: ${params.goal || "Not specified"}

Return only JSON:
{
  "competitors": [
    {
      "name": "Competitor or alternative name",
      "url": "https://example.com",
      "reason": "Why this is relevant"
    }
  ]
}`;

  const { text, usage } = await generateContent(prompt, "text/plain", true);
  recordAiUsage({
    userId: params.profile.userId,
    businessProfileId: params.profile.id,
    ...usage,
    modelName: usage.model,
    operation: "content_audit_competitor_discovery",
  }).catch(console.error);

  const parsed = parseJsonObject(text || "{}");
  return uniqueCompetitors(asArray(parsed.competitors));
}

async function summarizeCompetitor(params: {
  auditId: number;
  businessProfileId: number;
  userId: number;
  competitor: { name?: string; url?: string };
  mode: CompetitorAnalysisMode;
  sourceType: string;
  profile: any;
}) {
  const source = await prisma.competitorSource.create({
    data: {
      businessProfileId: params.businessProfileId,
      contentAuditId: params.auditId,
      name: params.competitor.name || null,
      url: params.competitor.url || null,
      mode: params.mode,
      sourceType: params.sourceType,
      status: "pending",
    },
  });

  try {
    let sourceText = "";
    if (params.competitor.url) {
      sourceText = await scrapeUrl(params.competitor.url);
    }

    if (!sourceText.trim()) {
      const searchPrompt = `Use Google Search to summarize this competitor or alternative for social media strategy.

Our business: ${params.profile.name} - ${params.profile.identity}
Competitor: ${params.competitor.name || params.competitor.url}
URL: ${params.competitor.url || "unknown"}

Return concise JSON:
{
  "positioning": "How they position themselves",
  "offers": ["Visible offers/services"],
  "audienceSignals": ["Who they seem to target"],
  "contentAngles": ["Content angles they appear to use"],
  "opportunities": ["Gaps our business can exploit"]
}`;
      const { text, usage } = await generateContent(
        searchPrompt,
        "text/plain",
        true,
      );
      recordAiUsage({
        userId: params.userId,
        businessProfileId: params.businessProfileId,
        ...usage,
        modelName: usage.model,
        operation: "content_audit_competitor_search_summary",
      }).catch(console.error);
      sourceText = text;
    }

    const summaryPrompt = `You are analyzing competitor intelligence for a content strategist.

Our business:
- Name: ${params.profile.name}
- Identity: ${params.profile.identity}
- Target audience: ${params.profile.targetAudience}
- Products/services: ${params.profile.productsServices.join(", ")}

Competitor source:
- Name: ${params.competitor.name || "Unknown"}
- URL: ${params.competitor.url || "Unknown"}
- Mode: ${params.mode}

Source material:
${trimForPrompt(sourceText, 6000)}

Return only JSON:
{
  "positioning": "Concise positioning summary",
  "offers": ["Offer/service insight"],
  "audienceSignals": ["Audience behavior or segment insight"],
  "contentAngles": ["Useful competitor content or messaging angle"],
  "opportunities": ["Specific opportunities for our business"],
  "confidence": 0.0
}`;

    const { text, usage } = await generateContent(
      summaryPrompt,
      "application/json",
      false,
    );
    recordAiUsage({
      userId: params.userId,
      businessProfileId: params.businessProfileId,
      ...usage,
      modelName: usage.model,
      operation: "content_audit_competitor_summary",
    }).catch(console.error);
    const summary = parseJsonObject(text || "{}");

    return await prisma.competitorSource.update({
      where: { id: source.id },
      data: {
        status: "completed",
        summary,
        evidenceRefs: [
          {
            id: `competitor-source:${source.id}`,
            sourceType: params.sourceType,
            label: params.competitor.name || params.competitor.url || "Competitor",
            url: params.competitor.url,
          },
        ],
      },
    });
  } catch (err: any) {
    return prisma.competitorSource.update({
      where: { id: source.id },
      data: {
        status: "failed",
        errorMessage: err.message || String(err),
      },
    });
  }
}

async function collectCompetitorSignals(params: {
  auditId: number;
  profile: any;
  input: ContentAuditInput;
}) {
  const modes = params.input.competitorAnalysisModes || ["WEBSITE_SEARCH"];
  let competitors = uniqueCompetitors(params.input.competitors || []);

  if (
    params.input.competitorDiscoveryScope === "AI_DISCOVERY" ||
    params.input.competitorDiscoveryScope === "PROVIDED_AND_AI_SEARCH"
  ) {
    try {
      const discovered = await discoverCompetitorsWithSearch({
        profile: params.profile,
        goal: params.input.goal,
      });
      competitors = uniqueCompetitors([...competitors, ...discovered]);
    } catch (err) {
      logger.warn("content_audit.competitor_discovery_failed", {
        businessProfileId: params.profile.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const sources: any[] = [];
  if (modes.includes("WEBSITE_SEARCH")) {
    for (const competitor of competitors.slice(0, 8)) {
      sources.push(
        await summarizeCompetitor({
          auditId: params.auditId,
          businessProfileId: params.profile.id,
          userId: params.profile.userId,
          competitor,
          mode: "WEBSITE_SEARCH",
          sourceType: "website",
          profile: params.profile,
        }),
      );
    }
  }

  if (modes.includes("PUBLIC_SOCIAL_SCRAPE")) {
    const socialUrls = competitors.filter((c) =>
      /(facebook|instagram|linkedin|tiktok|x\.com|twitter)\.com/i.test(
        c.url || "",
      ),
    );
    for (const competitor of socialUrls.slice(0, 6)) {
      sources.push(
        await summarizeCompetitor({
          auditId: params.auditId,
          businessProfileId: params.profile.id,
          userId: params.profile.userId,
          competitor,
          mode: "PUBLIC_SOCIAL_SCRAPE",
          sourceType: "public_social",
          profile: params.profile,
        }),
      );
    }
  }

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

function buildAuditPrompt(params: {
  profile: any;
  input: ContentAuditInput;
  firstParty: SignalBundle;
  competitorSources: any[];
}) {
  const competitorSummaries = params.competitorSources.map((source) => ({
    id: `competitor-source:${source.id}`,
    name: source.name,
    url: source.url,
    mode: source.mode,
    status: source.status,
    summary: source.summary,
    error: source.errorMessage,
  }));

  return `You are a senior social media strategist auditing a business before generating content.
Do not trust shallow owner answers blindly. If the owner says broad things like "everyone" or "price and quality", use the real signals to sharpen or challenge the brief.

Business profile:
${JSON.stringify(
  {
    name: params.profile.name,
    identity: params.profile.identity,
    targetAudience: params.profile.targetAudience,
    voice: params.profile.voice,
    tone: params.profile.tone,
    productsServices: params.profile.productsServices,
    expectedUserIntents: params.profile.expectedUserIntents,
    corePolicies: params.profile.corePolicies,
    aiBehaviorInstructions: params.profile.aiBehaviorInstructions,
    faqs: params.profile.faqs?.map((f: any) => ({
      question: f.question,
      answer: f.answer,
    })),
  },
  null,
  2,
)}

Owner campaign context:
${JSON.stringify(
  {
    goal: params.input.goal,
    currentTrends: params.input.currentTrends,
    startDate: params.input.startDate,
    endDate: params.input.endDate,
  },
  null,
  2,
)}

First-party signal summary:
${JSON.stringify(params.firstParty.summary, null, 2)}

Customer/inbox/comment signals:
${params.firstParty.customerQuestionSignals.join("\n")}

Public/live social signals:
${params.firstParty.liveSocialSignals.join("\n")}

Customer record signals:
${params.firstParty.customerSignals.join("\n")}

Existing content signals:
${params.firstParty.contentSignals.join("\n")}

Competitor intelligence:
${JSON.stringify(competitorSummaries, null, 2)}

Evidence refs available:
${JSON.stringify(params.firstParty.evidenceRefs.slice(0, 80), null, 2)}

Voice and tone rules:
- Write findings, gap questions, and draftBrief fields in the business profile voice/language/dialect and tone.
- The profile voice/tone are the source of truth. draftBrief.tonePreferences may add a campaign-specific note, but it must stay compatible with the profile voice/tone and must not change the language/dialect.
- Do not invent proof, claims, prices, guarantees, policies, statistics, or locations.

Return ONLY strict JSON:
{
  "confidenceScore": 0,
  "findings": [
    {
      "type": "audience|objection|content_gap|competitor_gap|offer|trust|cta",
      "title": "Short insight title",
      "insight": "Consultant-level insight tied to business impact",
      "businessImpact": "Why this matters",
      "confidence": 0.0,
      "evidenceRefs": ["message:1", "competitor-source:2"]
    }
  ],
  "gapQuestions": [
    {
      "id": "short_key",
      "question": "Only ask what cannot be inferred from signals",
      "reason": "Why this answer improves content quality",
      "priority": "high|medium|low"
    }
  ],
  "draftBrief": {
    "goal": "Specific campaign/business outcome",
    "audienceSegments": ["Sharpened audience segment"],
    "painPoints": ["Real customer pain point"],
    "objections": ["Real objection or buying friction"],
    "buyingTriggers": ["What makes people act now"],
    "offers": ["Offer or service angle to promote"],
    "proofPoints": ["Trust proof that exists or should be requested"],
    "cta": "Recommended call to action",
    "funnelFocus": "awareness|education|trust|conversion|retention|mixed",
    "tonePreferences": "Secondary campaign tone note that stays compatible with the business profile voice/tone",
    "forbiddenTopics": [],
    "competitorInsights": {
      "positioningGaps": ["Gap we can own"],
      "contentOpportunities": ["Content opportunity"],
      "risks": ["Risk or similarity to avoid"]
    }
  }
}`;
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
      message: "Drafting signal-led content brief and gap questions...",
      auditId: audit.id,
    };

    const prompt = buildAuditPrompt({
      profile,
      input,
      firstParty,
      competitorSources,
    });
    const { text, usage } = await generateContent(
      prompt,
      "application/json",
      false,
      undefined,
      0.25,
    );
    recordAiUsage({
      userId: input.userId,
      businessProfileId: input.businessProfileId,
      ...usage,
      modelName: usage.model,
      operation: "content_brief_audit",
    }).catch(console.error);

    const parsed = parseJsonObject(text || "{}");
    const updatedAudit = await prisma.contentAudit.update({
      where: { id: audit.id },
      data: {
        status: "completed",
        findings: parsed.findings || [],
        gapQuestions: parsed.gapQuestions || [],
        draftBrief: parsed.draftBrief || {},
        evidenceRefs: firstParty.evidenceRefs,
        confidenceScore: Number(parsed.confidenceScore || 0),
      },
      include: {
        competitorSources: true,
      },
    });

    yield {
      type: "result",
      data: {
        audit: updatedAudit,
        findings: parsed.findings || [],
        gapQuestions: parsed.gapQuestions || [],
        draftBrief: parsed.draftBrief || {},
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
