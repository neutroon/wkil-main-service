import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokePipelineEmbedding, invokePipelineEmbeddingQuery } from "@modules/ai-agent/core/pipelineRuntime";
import {
  assertQuotaAvailable,
  recordAiUsage,
} from "@modules/billing/billing.service";
import prisma from "@config/prisma";
import { AgentClient } from "@modules/ai-agent/client/agent.client";
import {
  ingestBusinessProfile,
  retrieveRelevantChunksWithEmbedding,
} from "./rag.service";

vi.mock("@modules/ai-agent/core/pipelineRuntime", () => ({
  invokePipelineText: vi.fn(),
  invokePipelineTextStream: vi.fn(),
  invokePipelineStructured: vi.fn(),
  invokePipelineEmbedding: vi.fn(),
  invokePipelineEmbeddingQuery: vi.fn(),
  invokePipelineImageGen: vi.fn(),
}));

vi.mock("@modules/billing/billing.service", () => ({
  assertQuotaAvailable: vi.fn(async () => undefined),
  recordAiUsage: vi.fn(async () => undefined),
}));

vi.mock("@config/prisma", () => ({
  default: {
    businessProfileChunk: {
      findMany: vi.fn(),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    businessProfile: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(async () => undefined),
    },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(async () => 0),
  },
  Prisma: {
    join: vi.fn((items) => items),
    sql: vi.fn((strings, ...values) => ({ strings, values })),
  },
}));

vi.mock("@modules/ai-agent/client/agent.client", () => ({
  AgentClient: {
    enabled: vi.fn(() => false),
    ingestRag: vi.fn(async () => ({})),
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

    expect(invokePipelineEmbeddingQuery).not.toHaveBeenCalled();
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
    vi.mocked(invokePipelineEmbeddingQuery).mockRejectedValueOnce(new Error("GEMINI_TIMEOUT"));
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

    expect(invokePipelineEmbeddingQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        pipeline: "embeddings",
        text: "semantic wording with no exact match",
        timeoutMs: expect.any(Number),
      }),
    );
    const calls = vi.mocked(invokePipelineEmbeddingQuery).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0]?.timeoutMs).toBeLessThanOrEqual(50);
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

    expect(invokePipelineEmbeddingQuery).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(result.queryEmbedding).toBeNull();
    expect(result.chunks).toEqual([
      expect.objectContaining({ chunkType: "identity" }),
    ]);
  });

  it("does not let slow vector search exceed the RAG retrieval budget", async () => {
    vi.mocked(invokePipelineEmbeddingQuery).mockResolvedValueOnce({
      vector: [0.1, 0.2, 0.3],
      usage: {
        promptTokens: 7,
        completionTokens: 0,
        totalTokens: 7,
        groundingCalls: 0,
        model: "gemini-embedding-001",
        provider: "google",
      },
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

describe("rag dual-write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls AgentClient.ingestRag with mode=full when enabled", async () => {
    process.env.USE_AGENT_SERVICE = "true";
    vi.mocked(AgentClient.enabled).mockReturnValue(true);
    vi.mocked(prisma.businessProfile.findUniqueOrThrow).mockResolvedValue({
      id: 1,
      userId: 20,
      name: "Acme",
      faqs: [],
      knowledgeSections: [],
    } as any);
    vi.mocked(invokePipelineEmbedding).mockResolvedValue({
      embeddings: [[0.1, 0.2, 0.3]],
      usage: {
        promptTokens: 1,
        completionTokens: 0,
        totalTokens: 1,
        groundingCalls: 0,
        model: "gemini-embedding-001",
        provider: "google",
      },
    });
    const spy = vi.spyOn(AgentClient, "ingestRag").mockResolvedValue({} as any);

    await ingestBusinessProfile(1);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        business_profile_id: 1,
        mode: "full",
        collection: "rag",
      }),
    );
  });

  it("does not call AgentClient.ingestRag when disabled", async () => {
    process.env.USE_AGENT_SERVICE = "false";
    vi.mocked(AgentClient.enabled).mockReturnValue(false);
    vi.mocked(prisma.businessProfile.findUniqueOrThrow).mockResolvedValue({
      id: 2,
      userId: 30,
      name: "Beta",
      faqs: [],
      knowledgeSections: [],
    } as any);
    vi.mocked(invokePipelineEmbedding).mockResolvedValue({
      embeddings: [[0.1, 0.2, 0.3]],
      usage: {
        promptTokens: 1,
        completionTokens: 0,
        totalTokens: 1,
        groundingCalls: 0,
        model: "gemini-embedding-001",
        provider: "google",
      },
    });
    const spy = vi.spyOn(AgentClient, "ingestRag").mockResolvedValue({} as any);

    await ingestBusinessProfile(2);

    expect(spy).not.toHaveBeenCalled();
  });
});
