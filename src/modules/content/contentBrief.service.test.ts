import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@config/prisma", () => ({
  default: {
    businessProfile: {
      findFirst: vi.fn(),
    },
    conversationMessage: {
      findMany: vi.fn(),
    },
    conversation: {
      findMany: vi.fn(),
    },
    customer: {
      findMany: vi.fn(),
    },
    contentPlan: {
      findMany: vi.fn(),
    },
    contentBrief: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    contentAudit: {
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
    },
    competitorSource: {
      create: vi.fn(),
    },
  },
}));

vi.mock("../meta/facebook/facebook.service", () => ({
  getPagePosts: vi.fn(),
  getPostComments: vi.fn(),
}));

vi.mock("../billing/billing.service", () => ({
  assertQuotaAvailable: vi.fn(),
  recordAiUsage: vi.fn(),
}));

vi.mock("@utils/apiClient", () => ({
  internalClient: {
    post: vi.fn(),
  },
}));

vi.mock("@modules/ai-agent/client/agent.client", () => ({
  AgentClient: {
    runCapability: vi.fn(),
  },
}));

import prisma from "@config/prisma";
import { AgentClient } from "@modules/ai-agent/client/agent.client";
import { getPagePosts, getPostComments } from "../meta/facebook/facebook.service";
import {
  collectFirstPartySignals,
  generateContentAuditStream,
  saveContentBrief,
} from "./contentBrief.service";

const mockedPrisma = prisma as any;

describe("content brief service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.businessProfile.findFirst.mockResolvedValue({
      id: 10,
      userId: 7,
      name: "Wkil",
      facebookPages: [],
    });
    mockedPrisma.conversationMessage.findMany.mockResolvedValue([]);
    mockedPrisma.conversation.findMany.mockResolvedValue([]);
    mockedPrisma.customer.findMany.mockResolvedValue([]);
    mockedPrisma.contentPlan.findMany.mockResolvedValue([]);
    vi.mocked(getPagePosts).mockResolvedValue({ data: [] } as never);
    vi.mocked(getPostComments).mockResolvedValue({ data: [] } as never);
  });

  it("collects first-party signals with a bounded 90-day business filter", async () => {
    const now = Date.now();
    mockedPrisma.conversationMessage.findMany.mockResolvedValue([
      {
        id: 1,
        content: "How much does setup cost?",
        createdAt: new Date(now - 1000),
        intent: "PRICE_QUESTION",
        handoffCategory: null,
        conversation: {
          channel: "messenger",
          postId: null,
          sourceCommentText: null,
          customerName: "Mona",
        },
      },
    ]);
    mockedPrisma.conversation.findMany.mockResolvedValue([
      {
        id: 2,
        postId: "fb_1",
        sourceCommentText: "Can you send details?",
        updatedAt: new Date(now - 2000),
      },
    ]);
    mockedPrisma.customer.findMany.mockResolvedValue([
      {
        id: 3,
        primaryChannel: "whatsapp",
        status: "ACTIVE",
        capturedFields: { need: "demo" },
        lastInteractionAt: new Date(now - 3000),
      },
    ]);

    const result = await collectFirstPartySignals({
      businessProfileId: 10,
      userId: 7,
      signalWindowDays: 90,
    });

    expect(result.summary.messageCount).toBe(1);
    expect(result.summary.commentThreadCount).toBe(1);
    expect(result.summary.customerCount).toBe(1);
    expect(result.customerQuestionSignals[0]).toContain("PRICE_QUESTION");
    expect(result.commentSignals[0]).toContain("comment-thread:2");
    expect(result.evidenceRefs.map((ref) => ref.id)).toEqual(
      expect.arrayContaining(["message:1", "comment-thread:2", "customer:3"]),
    );
    expect(mockedPrisma.conversationMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { gte: expect.any(Date) },
          conversation: expect.objectContaining({
            businessProfileId: 10,
            businessProfile: { userId: 7 },
          }),
        }),
      }),
    );
  });

  it("keeps a customer signal without creating an evidence timestamp when activity is null", async () => {
    mockedPrisma.customer.findMany.mockResolvedValue([
      {
        id: 4,
        primaryChannel: "whatsapp",
        status: "ACTIVE",
        capturedFields: {},
        lastInteractionAt: null,
      },
    ]);

    const result = await collectFirstPartySignals({
      businessProfileId: 10,
      userId: 7,
      signalWindowDays: 90,
    });

    expect(result.summary.customerCount).toBe(1);
    expect(result.customerSignals).toEqual([
      "source=customer:4 | channel=whatsapp | status=ACTIVE | captured_fields={}",
    ]);
    expect(result.evidenceRefs).toContainEqual({
      id: "customer:4",
      sourceType: "whatsapp",
      label: "whatsapp record",
    });
  });

  it("saves a confirmed brief only for an owned profile and source audit", async () => {
    mockedPrisma.contentAudit.findFirst.mockResolvedValue({ id: 5 });
    mockedPrisma.contentBrief.create.mockImplementation((args: any) =>
      Promise.resolve({ id: 20, ...args.data }),
    );

    const brief = await saveContentBrief(7, {
      businessProfileId: 10,
      sourceAuditId: 5,
      goal: "Generate qualified WhatsApp leads",
      audienceSegments: ["SMB owners"],
      painPoints: ["Missed messages"],
    });

    expect(mockedPrisma.businessProfile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 10, userId: 7 },
      }),
    );
    expect(mockedPrisma.contentAudit.findFirst).toHaveBeenCalledWith({
      where: {
        id: 5,
        businessProfileId: 10,
        userId: 7,
      },
    });
    expect(brief.goal).toBe("Generate qualified WhatsApp leads");
    expect(mockedPrisma.contentBrief.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          businessProfileId: 10,
          userId: 7,
          sourceAuditId: 5,
          status: "confirmed",
        }),
      }),
    );
  });

  it("passes all audit inputs and collected signals to the typed capability before persisting", async () => {
    mockedPrisma.businessProfile.findFirst.mockResolvedValue({
      id: 10,
      userId: 7,
      name: "Nile Coffee",
      voice: "Warm",
      tone: "Casual",
      facebookPages: [],
    });
    mockedPrisma.contentAudit.create.mockResolvedValue({ id: 50 });
    vi.mocked(AgentClient.runCapability).mockResolvedValue({
      findings: ["Customer questions focus on delivery speed"],
      gap_questions: ["Which Cairo districts convert best?"],
      draft_brief: {
        goal: "Grow subscriptions",
        audience_segments: ["Busy Cairo professionals"],
      },
      confidence_score: 0.84,
    });
    mockedPrisma.contentAudit.update.mockResolvedValue({
      id: 50,
      status: "completed",
      competitorSources: [],
    });

    const updates = [];
    for await (const update of generateContentAuditStream({
      userId: 7,
      businessProfileId: 10,
      goal: "Grow subscriptions",
      startDate: "2026-09-07",
      endDate: "2026-09-30",
      currentTrends: "office coffee subscriptions",
      signalWindowDays: 30,
      competitorDiscoveryScope: "PROVIDED_ONLY",
      competitorAnalysisModes: ["WEBSITE_SEARCH"],
      competitors: [{ name: "Bean Co", url: "https://bean.example" }],
      socialSamples: [],
    })) {
      updates.push(update);
    }

    expect(AgentClient.runCapability).toHaveBeenCalledWith({
      userId: 7,
      businessProfileId: 10,
      operation: "content_audit",
      context: {
        goal: "Grow subscriptions",
        startDate: "2026-09-07",
        endDate: "2026-09-30",
        currentTrends: "office coffee subscriptions",
        settings: { name: "Nile Coffee", voice: "Warm", tone: "Casual" },
        signals: {
          firstParty: expect.objectContaining({
            summary: expect.objectContaining({ signalWindowDays: 30 }),
          }),
          competitors: [{ name: "Bean Co", url: "https://bean.example" }],
          socialSamples: [],
          competitorDiscoveryScope: "PROVIDED_ONLY",
          competitorAnalysisModes: ["WEBSITE_SEARCH"],
          competitorSources: [],
        },
      },
    });
    expect(mockedPrisma.contentAudit.update).toHaveBeenCalledWith({
      where: { id: 50 },
      data: {
        status: "completed",
        findings: [{ title: "Customer questions focus on delivery speed" }],
        gapQuestions: [
          { id: "gap_1", question: "Which Cairo districts convert best?" },
        ],
        draftBrief: {
          goal: "Grow subscriptions",
          audienceSegments: ["Busy Cairo professionals"],
        },
        evidenceRefs: [],
        confidenceScore: 0.84,
      },
      include: { competitorSources: true },
    });
    expect(updates.at(-1)).toMatchObject({
      type: "result",
      data: {
        findings: [{ title: "Customer questions focus on delivery speed" }],
      },
    });
  });
});
