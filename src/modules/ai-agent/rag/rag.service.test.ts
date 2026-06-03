import { beforeEach, describe, expect, it, vi } from "vitest";
import { embedQuery } from "../gemini";
import {
  assertQuotaAvailable,
  recordAiUsage,
} from "@modules/billing/billing.service";
import prisma from "@config/prisma";
import { retrieveRelevantChunksWithEmbedding } from "./rag.service";

vi.mock("../gemini", () => ({
  embedQuery: vi.fn(),
  embedTexts: vi.fn(),
}));

vi.mock("@modules/billing/billing.service", () => ({
  assertQuotaAvailable: vi.fn(async () => undefined),
  recordAiUsage: vi.fn(async () => undefined),
}));

vi.mock("@config/prisma", () => ({
  default: {
    businessProfileChunk: {
      findMany: vi.fn(),
    },
    businessProfile: {
      findUnique: vi.fn(),
    },
    $queryRaw: vi.fn(),
  },
  Prisma: {
    join: vi.fn((items) => items),
    sql: vi.fn((strings, ...values) => ({ strings, values })),
  },
}));

vi.mock("@utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("retrieveRelevantChunksWithEmbedding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses strong lexical and core context without waiting for query embedding", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      {
        id: 2,
        chunkType: "custom_section",
        content: "الدعم النفسى بالفنون متاح للحجز.",
      },
    ] as any);
    vi.mocked(prisma.businessProfileChunk.findMany)
      .mockResolvedValueOnce([
        {
          id: 1,
          chunkType: "identity",
          content: "Business identity.",
        },
      ] as any);

    const result = await retrieveRelevantChunksWithEmbedding(
      10,
      "عاوز احجز الدعم النفسى بالفنون",
      5,
      { userId: 20, timeoutMs: 50 },
    );

    expect(embedQuery).not.toHaveBeenCalled();
    expect(assertQuotaAvailable).toHaveBeenCalledWith(20, 10);
    expect(recordAiUsage).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(result.queryEmbedding).toBeNull();
    expect(result.chunks).toEqual([
      expect.objectContaining({ chunkType: "identity" }),
      expect.objectContaining({ chunkType: "custom_section" }),
    ]);
  });

  it("falls back to available lexical and core context when embedding times out", async () => {
    vi.mocked(embedQuery).mockRejectedValueOnce(new Error("GEMINI_TIMEOUT"));
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([] as any);
    vi.mocked(prisma.businessProfileChunk.findMany)
      .mockResolvedValueOnce([
        {
          id: 1,
          chunkType: "identity",
          content: "Business identity.",
        },
      ] as any);

    const result = await retrieveRelevantChunksWithEmbedding(
      10,
      "semantic wording with no exact match",
      5,
      { userId: 20, timeoutMs: 50 },
    );

    expect(embedQuery).toHaveBeenCalledWith(
      "semantic wording with no exact match",
      { timeoutMs: expect.any(Number) },
    );
    expect(vi.mocked(embedQuery).mock.calls[0]?.[1]?.timeoutMs).toBeLessThanOrEqual(50);
    expect(assertQuotaAvailable).toHaveBeenCalledWith(20, 10);
    expect(recordAiUsage).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(result.queryEmbedding).toBeNull();
    expect(result.chunks).toEqual([
      expect.objectContaining({ chunkType: "identity" }),
    ]);
  });

  it("does not spend vector-search budget on very short queries without lexical evidence", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([] as any);
    vi.mocked(prisma.businessProfileChunk.findMany).mockResolvedValueOnce([
      {
        id: 1,
        chunkType: "identity",
        content: "Business identity.",
      },
    ] as any);

    const result = await retrieveRelevantChunksWithEmbedding(
      10,
      "أهلاً",
      5,
      { userId: 20, timeoutMs: 50 },
    );

    expect(embedQuery).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(result.queryEmbedding).toBeNull();
    expect(result.chunks).toEqual([
      expect.objectContaining({ chunkType: "identity" }),
    ]);
  });

  it("does not let slow vector search exceed the RAG retrieval budget", async () => {
    vi.mocked(embedQuery).mockResolvedValueOnce({
      vector: [0.1, 0.2, 0.3],
      totalTokens: 7,
    });
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      {
        id: 2,
        chunkType: "custom_section",
        content: "تفاصيل عامة لا تطابق السؤال.",
      },
    ] as any);
    vi.mocked(prisma.businessProfileChunk.findMany)
      .mockResolvedValueOnce([
        {
          id: 1,
          chunkType: "identity",
          content: "Business identity.",
        },
      ] as any);
    vi.mocked(prisma.$queryRaw).mockReturnValueOnce(
      new Promise(() => undefined) as any,
    );

    const startedAt = Date.now();
    const result = await retrieveRelevantChunksWithEmbedding(
      10,
      "ما هي البرامج التدريبية المتاحة؟",
      5,
      { userId: 20, timeoutMs: 25 },
    );

    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(recordAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 20,
        businessProfileId: 10,
        embeddingTokens: 7,
        operation: "rag_retrieve",
      }),
    );
    expect(result.queryEmbedding).toEqual([0.1, 0.2, 0.3]);
    expect(result.chunks).toEqual([
      expect.objectContaining({ chunkType: "identity" }),
    ]);
  });
});
