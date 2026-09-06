import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  businessProfile: { findUnique: vi.fn(), findFirst: vi.fn() },
  contentPlan: { update: vi.fn(), findUnique: vi.fn() },
  contentPlanPost: { findFirst: vi.fn(), update: vi.fn() },
}));
vi.mock("@config/prisma", () => ({ default: prismaMock }));

const agentClient = vi.hoisted(() => ({ runCapability: vi.fn() }));
vi.mock("@modules/ai-agent/client/agent.client", () => ({ AgentClient: agentClient }));

const briefService = vi.hoisted(() => ({ getContentBriefForStrategy: vi.fn() }));
vi.mock("./contentBrief.service", () => briefService);

const copilotService = vi.hoisted(() => ({ generateCopilotContentPlan: vi.fn() }));
vi.mock("./contentCopilot.service", () => copilotService);

import {
  generateContentStrategyStream,
  generatePostExecution,
} from "./contentPlan.service";

beforeEach(() => vi.clearAllMocks());

describe("generateContentStrategyStream", () => {
  it("rejects a profile that is not owned by the authenticated user", async () => {
    prismaMock.businessProfile.findFirst.mockResolvedValue(null);
    const generator = generateContentStrategyStream({
      userId: 7,
      businessProfileId: 99,
      startDate: "2026-09-07",
      endDate: "2026-09-30",
      goals: "Grow subscriptions",
    });
    await expect(generator.next()).rejects.toMatchObject({ statusCode: 404 });
  });

  it("passes the complete strategy brief to the capability and persists its typed draft", async () => {
    prismaMock.businessProfile.findFirst.mockResolvedValue({
      id: 10,
      name: "Nile Coffee",
      voice: "Warm",
      tone: "Casual",
    });
    briefService.getContentBriefForStrategy.mockResolvedValue({
      id: 21,
      sourceAuditId: 5,
      goal: "Grow subscriptions",
      audienceSegments: ["Busy Cairo professionals"],
      painPoints: ["Running out of coffee"],
      objections: ["Subscription commitment"],
      buyingTriggers: ["Fresh weekly roast"],
      offers: ["First month 20% off"],
      proofPoints: ["Roasted every Monday"],
      cta: "Subscribe today",
      funnelFocus: "conversion",
      tonePreferences: "Warm and direct",
      forbiddenTopics: ["Medical claims"],
      competitorInsights: { gap: "Few local subscriptions" },
    });
    const draft = {
      goals: ["Grow subscriptions"],
      posts: [
        {
          scheduled_at: "2026-09-07",
          pillar: "product",
          topic: "Never run out of fresh coffee",
          format: "single_image",
          funnel_stage: "conversion",
        },
      ],
    };
    agentClient.runCapability.mockResolvedValue(draft);
    copilotService.generateCopilotContentPlan.mockResolvedValue({ planId: 31 });
    prismaMock.contentPlan.update.mockResolvedValue({ id: 31 });
    prismaMock.contentPlan.findUnique.mockResolvedValue({ id: 31, posts: [] });

    const updates = [];
    for await (const update of generateContentStrategyStream({
      userId: 7,
      businessProfileId: 10,
      contentBriefId: 21,
      startDate: "2026-09-07",
      endDate: "2026-09-30",
      goals: "Grow subscriptions",
      currentTrends: ["office coffee", "weekly delivery"],
    })) {
      updates.push(update);
    }

    expect(agentClient.runCapability).toHaveBeenCalledWith({
      userId: 7,
      businessProfileId: 10,
      operation: "content_plan",
      context: {
        goal: "Grow subscriptions",
        startDate: "2026-09-07",
        endDate: "2026-09-30",
        platform: "facebook",
        settings: { name: "Nile Coffee", voice: "Warm", tone: "Casual" },
        knowledge: [
          { source: "current_trends", content: "office coffee, weekly delivery" },
          {
            source: "content_brief",
            content: {
              id: 21,
              sourceAuditId: 5,
              goal: "Grow subscriptions",
              audienceSegments: ["Busy Cairo professionals"],
              painPoints: ["Running out of coffee"],
              objections: ["Subscription commitment"],
              buyingTriggers: ["Fresh weekly roast"],
              offers: ["First month 20% off"],
              proofPoints: ["Roasted every Monday"],
              cta: "Subscribe today",
              funnelFocus: "conversion",
              tonePreferences: "Warm and direct",
              forbiddenTopics: ["Medical claims"],
              competitorInsights: { gap: "Few local subscriptions" },
            },
          },
        ],
      },
    });
    expect(copilotService.generateCopilotContentPlan).toHaveBeenCalledWith({
      userId: 7,
      businessProfileId: 10,
      draft,
      goal: "Grow subscriptions",
      platform: "facebook",
    });
    expect(prismaMock.contentPlan.update).toHaveBeenCalledWith({
      where: { id: 31 },
      data: {
        contentBriefId: 21,
        startDate: new Date("2026-09-07"),
        endDate: new Date("2026-09-30"),
        currentTrends: "office coffee, weekly delivery",
        briefSnapshot: expect.objectContaining({
          id: 21,
          competitorInsights: { gap: "Few local subscriptions" },
        }),
      },
    });
    expect(updates.at(-1)).toEqual({
      type: "result",
      data: { id: 31, posts: [] },
    });
  });
});

describe("generatePostExecution", () => {
  it("passes the saved plan and post brief to the capability before persisting the result", async () => {
    prismaMock.contentPlanPost.findFirst.mockResolvedValue({
      id: 41,
      scheduledAt: new Date("2026-09-09T10:00:00Z"),
      platform: "facebook",
      pillar: "education",
      topic: "How freshness changes flavor",
      format: "carousel",
      funnelStage: "consideration",
      contentGoal: "Build trust",
      targetPainPoint: "Stale supermarket coffee",
      objectionHandled: "Local coffee costs more",
      cta: "Try this week's roast",
      rationale: "Teach before selling",
      evidenceRefs: [{ id: "message:4" }],
      contentPlan: {
        id: 31,
        businessProfileId: 10,
        startDate: new Date("2026-09-07T00:00:00Z"),
        endDate: new Date("2026-09-30T00:00:00Z"),
        goals: "Grow subscriptions",
        currentTrends: "office coffee",
        briefSnapshot: { cta: "Subscribe today" },
      },
    });
    prismaMock.businessProfile.findUnique.mockResolvedValue({
      name: "Nile Coffee",
      voice: "Warm",
      tone: "Casual",
    });
    agentClient.runCapability.mockResolvedValue({
      caption: "Freshness is the flavor you can smell before the first sip.",
      hashtags: ["#FreshCoffee"],
      suggested_image: null,
      image_prompt: "Three panels showing roast-to-cup freshness",
      reel_script: null,
      carousel_slides: null,
    });
    prismaMock.contentPlanPost.update.mockResolvedValue({ id: 41, status: "generated" });

    const updated = await generatePostExecution(41, 7);

    expect(agentClient.runCapability).toHaveBeenCalledWith({
      userId: 7,
      businessProfileId: 10,
      operation: "content_post",
      context: {
        topic: "How freshness changes flavor",
        post: {
          scheduledAt: "2026-09-09T10:00:00.000Z",
          platform: "facebook",
          pillar: "education",
          topic: "How freshness changes flavor",
          format: "carousel",
          funnelStage: "consideration",
          contentGoal: "Build trust",
          targetPainPoint: "Stale supermarket coffee",
          objectionHandled: "Local coffee costs more",
          cta: "Try this week's roast",
          rationale: "Teach before selling",
          evidenceRefs: [{ id: "message:4" }],
        },
        business: { name: "Nile Coffee", voice: "Warm", tone: "Casual" },
        plan: {
          startDate: "2026-09-07T00:00:00.000Z",
          endDate: "2026-09-30T00:00:00.000Z",
          goals: "Grow subscriptions",
          currentTrends: "office coffee",
          briefSnapshot: { cta: "Subscribe today" },
        },
      },
    });
    expect(prismaMock.contentPlanPost.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: {
        caption: "Freshness is the flavor you can smell before the first sip.",
        imagePrompt: "Three panels showing roast-to-cup freshness",
        status: "generated",
      },
    });
    expect(updated).toEqual({ id: 41, status: "generated" });
  });
});
