import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  contentPlanPost: { findFirst: vi.fn(), update: vi.fn() },
  contentPlan: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("@config/prisma", () => ({ default: prismaMock }));

const socialQueueMock = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("./social.queue", () => ({ socialQueue: socialQueueMock }));

const userSvc = vi.hoisted(() => ({ getAccessibleProfileIds: vi.fn() }));
vi.mock("@modules/auth/user/user.service", () => userSvc);

import {
  approveContentPost,
  deleteCopilotContentPlan,
  generateCopilotContentPlan,
  generateCopilotPostContent,
  getCopilotContentPlan,
  listCopilotContentPlans,
} from "./contentCopilot.service";

beforeEach(() => vi.clearAllMocks());

describe("approveContentPost", () => {
  it("extracted logic keeps ownership check + publish enqueue", async () => {
    prismaMock.contentPlanPost.findFirst.mockResolvedValue({
      id: 5,
      contentPlan: { userId: 7 },
      platform: "facebook",
      status: "generated",
    });
    prismaMock.contentPlanPost.update.mockResolvedValue({ id: 5, approved: true });
    const out = await approveContentPost({ userId: 7, postId: 5 });
    expect(prismaMock.contentPlanPost.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5 },
      }),
    );
    expect(socialQueueMock.add).toHaveBeenCalled();
    expect(out.ok).toBe(true);
  });

  it("rejects foreign posts", async () => {
    prismaMock.contentPlanPost.findFirst.mockResolvedValue(null);
    await expect(approveContentPost({ userId: 7, postId: 999 })).rejects.toThrow(
      "not found",
    );
  });
});

describe("generateCopilotContentPlan", () => {
  it("persists draft posts with camelCase mapping", async () => {
    prismaMock.contentPlan.create.mockResolvedValue({ id: 11 });
    const out = await generateCopilotContentPlan({
      userId: 7,
      businessProfileId: 1,
      goal: "g",
      platform: "facebook",
      draft: {
        goals: ["g"],
        posts: [
          {
            scheduled_at: "2026-09-07",
            pillar: "product",
            topic: "t",
            format: "single_image",
            funnel_stage: "awareness",
            caption: "c",
            image_prompt: "i",
          },
        ],
      },
    });
    const created = prismaMock.contentPlan.create.mock.calls[0][0].data;
    expect(created.posts.create[0]).toMatchObject({
      scheduledAt: new Date("2026-09-07"),
      funnelStage: "awareness",
      imagePrompt: "i",
    });
    expect(out.planId).toBe(11);
    expect(out.envelopes[0].type).toBe("content-plan");
  });
});

describe("listCopilotContentPlans", () => {
  it("scopes to accessible profiles", async () => {
    userSvc.getAccessibleProfileIds.mockResolvedValue([3, 4]);
    prismaMock.contentPlan.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const out = await listCopilotContentPlans({ userId: 7, limit: 5 });
    expect(userSvc.getAccessibleProfileIds).toHaveBeenCalledWith(7);
    const where = prismaMock.contentPlan.findMany.mock.calls[0][0].where;
    expect(where.businessProfileId).toEqual({ in: [3, 4] });
    expect(out.plans).toHaveLength(2);
    expect(out.meta.limit).toBe(5);
  });
});

describe("getCopilotContentPlan", () => {
  it("returns the plan for the owner", async () => {
    prismaMock.contentPlan.findFirst.mockResolvedValue({ id: 3, posts: [] });
    const out = await getCopilotContentPlan({ userId: 7, planId: 3 });
    expect(prismaMock.contentPlan.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 3, userId: 7 } }),
    );
    expect(out.id).toBe(3);
  });

  it("404s foreign plans", async () => {
    prismaMock.contentPlan.findFirst.mockResolvedValue(null);
    await expect(
      getCopilotContentPlan({ userId: 7, planId: 999 }),
    ).rejects.toThrow("not found");
  });
});

describe("deleteCopilotContentPlan", () => {
  it("deletes a scoped plan", async () => {
    prismaMock.contentPlan.findFirst.mockResolvedValue({ id: 3 });
    const out = await deleteCopilotContentPlan({ userId: 7, planId: 3 });
    expect(prismaMock.contentPlan.delete).toHaveBeenCalledWith({
      where: { id: 3 },
    });
    expect(out.ok).toBe(true);
  });

  it("404s foreign plans", async () => {
    prismaMock.contentPlan.findFirst.mockResolvedValue(null);
    await expect(
      deleteCopilotContentPlan({ userId: 7, planId: 999 }),
    ).rejects.toThrow("not found");
  });
});

describe("generateCopilotPostContent", () => {
  it("updates the owned post to generated", async () => {
    prismaMock.contentPlanPost.findFirst.mockResolvedValue({ id: 5 });
    prismaMock.contentPlanPost.update.mockResolvedValue({
      id: 5,
      status: "generated",
    });
    const out = await generateCopilotPostContent({
      userId: 7,
      postId: 5,
      caption: "c",
      imagePrompt: "i",
    });
    expect(prismaMock.contentPlanPost.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 5, contentPlan: { userId: 7 } },
      }),
    );
    expect(prismaMock.contentPlanPost.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { caption: "c", imagePrompt: "i", status: "generated" },
    });
    expect(out.ok).toBe(true);
  });

  it("404s foreign posts", async () => {
    prismaMock.contentPlanPost.findFirst.mockResolvedValue(null);
    await expect(
      generateCopilotPostContent({ userId: 7, postId: 999, caption: "c" }),
    ).rejects.toThrow("not found");
  });
});
