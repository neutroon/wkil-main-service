import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@config/prisma";
import { embedTexts } from "@modules/ai-agent/gemini";
import {
  buildExternalActionRoutingText,
  ensureExternalActionSemanticIndex,
  findSemanticallyEligibleExternalDataSources,
  hashExternalActionRoutingText,
} from "./externalActionSemanticIndex.service";

vi.mock("@config/prisma", () => ({
  default: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    businessProfile: {
      findUnique: vi.fn(),
    },
    externalDataSource: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@modules/ai-agent/gemini", () => ({
  embedTexts: vi.fn(),
}));

vi.mock("@modules/billing/billing.service", () => ({
  assertQuotaAvailable: vi.fn(async () => undefined),
  recordAiUsage: vi.fn(() => Promise.resolve()),
}));

vi.mock("@utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const priceSource = {
  id: 2,
  businessProfileId: 1,
  name: "Course availability",
  description: "Checks live course seats and availability",
  trigger: "CHAT_REQUESTED",
  actionType: "LOOKUP",
  isActive: true,
  expectedParamsSchema: {
    programName: {
      type: "STRING",
      source: "USER_PROVIDED",
      required: true,
      description: "Program name from the customer",
    },
  },
};

describe("external action semantic index", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds stable routing text and hash from action metadata", () => {
    const text = buildExternalActionRoutingText(priceSource);
    const sameMeaningDifferentOrder = buildExternalActionRoutingText({
      ...priceSource,
      expectedParamsSchema: {
        programName: {
          description: "Program name from the customer",
          required: true,
          source: "USER_PROVIDED",
          type: "STRING",
        },
      },
    });

    expect(text).toContain("Course availability");
    expect(text).toContain("Checks live course seats");
    expect(text).toContain("programName");
    expect(hashExternalActionRoutingText(text)).toBe(
      hashExternalActionRoutingText(sameMeaningDifferentOrder),
    );
  });

  it("stores a fresh embedding when the routing hash is missing", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([]);
    vi.mocked(prisma.businessProfile.findUnique).mockResolvedValueOnce({
      userId: 9,
    } as never);
    vi.mocked(embedTexts).mockResolvedValueOnce({
      embeddings: [[0.1, 0.2, 0.3]],
      totalTokens: 11,
    });

    await expect(
      ensureExternalActionSemanticIndex(priceSource),
    ).resolves.toMatchObject({ indexed: true });

    expect(embedTexts).toHaveBeenCalledWith([
      buildExternalActionRoutingText(priceSource),
    ]);
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it("returns only semantic hits above threshold and caps tool count", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      { id: 2, similarity: 0.72 },
      { id: 3, similarity: 0.44 },
    ]);

    const orderSource = {
      ...priceSource,
      id: 3,
      name: "Order status",
      description: "Checks order status by order ID",
    };

    await expect(
      findSemanticallyEligibleExternalDataSources({
        businessProfileId: 1,
        sources: [priceSource, orderSource],
        queryEmbedding: [0.1, 0.2, 0.3],
        maxTools: 1,
        minSimilarity: 0.5,
      }),
    ).resolves.toEqual([priceSource]);

    expect(prisma.$queryRaw).toHaveBeenCalled();
  });
});
