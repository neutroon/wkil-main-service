import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  businessProfile: { findFirst: vi.fn() },
}));
vi.mock("@config/prisma", () => ({ default: prismaMock }));

const contentService = vi.hoisted(() => ({ generatePostContent: vi.fn() }));
vi.mock("./content.service", () => contentService);
vi.mock("./contentPlan.service", () => ({ generatePostExecution: vi.fn() }));
vi.mock("./contentBrief.service", () => ({
  generateContentAuditStream: vi.fn(),
  getContentBrief: vi.fn(),
  saveContentBrief: vi.fn(),
}));
vi.mock("./contentCopilot.service", () => ({
  approveContentPost: vi.fn(),
  deleteCopilotContentPlan: vi.fn(),
}));
vi.mock("@modules/auth/core/auth.middleware", () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { id: 7 };
    next();
  },
}));
vi.mock("@middlewares/rateLimit.middleware", () => ({
  contentLimiter: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("@middlewares/validate.middleware", () => ({
  validate: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("@modules/media/upload.config", () => ({
  default: { single: () => (_req: any, _res: any, next: any) => next() },
}));

import contentRoutes from "./content.routes";

const app = express();
app.use(express.json());
app.use(contentRoutes);

beforeEach(() => vi.clearAllMocks());

describe("POST /generate-post", () => {
  it("passes canonical authenticated tenant IDs and all requested content inputs", async () => {
    prismaMock.businessProfile.findFirst.mockResolvedValue({
      id: 10,
      name: "Nile Coffee",
      voice: "Warm",
      tone: "Casual",
      corePolicies: "No medical claims",
      aiBehaviorInstructions: "Use Egyptian Arabic when natural",
    });
    contentService.generatePostContent.mockResolvedValue({
      content: "Caption",
      hashtags: [],
      suggestedImage: null,
    });

    const response = await request(app).post("/generate-post").send({
      businessProfileId: 10,
      topic: "Fresh roast delivery",
      length: "short",
      keywords: ["Cairo"],
      context: "Mention two-day delivery",
      generateImage: true,
    });

    expect(response.status).toBe(200);
    expect(contentService.generatePostContent).toHaveBeenCalledWith({
      userId: 7,
      businessProfileId: 10,
      topic: "Fresh roast delivery",
      length: "short",
      keywords: ["Cairo"],
      context: "Mention two-day delivery",
      generateImage: true,
      businessProfile: {
        id: 10,
        name: "Nile Coffee",
        voice: "Warm",
        tone: "Casual",
        corePolicies: "No medical claims",
        aiBehaviorInstructions: "Use Egyptian Arabic when natural",
      },
    });
  });
});
