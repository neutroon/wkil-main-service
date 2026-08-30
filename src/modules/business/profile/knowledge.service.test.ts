import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  businessProfile: { findFirst: vi.fn(), update: vi.fn() },
  knowledgeDocument: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), findFirst: vi.fn() },
}));
vi.mock("@config/prisma", () => ({ default: prismaMock }));

const agentClient = vi.hoisted(() => ({ ingestRag: vi.fn() }));
vi.mock("@modules/ai-agent/client/agent.client", () => ({ AgentClient: agentClient }));

import {
  listKnowledgeDocuments,
  createKnowledgeDocument,
  updateKnowledgeDocument,
  deleteKnowledgeDocument,
  ingestProfileDocuments,
} from "./knowledge.service";

beforeEach(() => vi.clearAllMocks());

describe("listKnowledgeDocuments", () => {
  it("filters by kind and q and wraps a knowledge-list envelope", async () => {
    prismaMock.knowledgeDocument.findMany.mockResolvedValue([
      { id: 1, kind: "faq", title: "Refunds?", content: "Q: Refunds?\nA: 14 days", updatedAt: new Date() },
    ]);
    const out = await listKnowledgeDocuments(3, { kind: "faq", q: "refund", limit: 5 });
    expect(prismaMock.knowledgeDocument.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ businessProfileId: 3, kind: "faq" }),
    }));
    expect(out.envelopes[0]).toMatchObject({ type: "knowledge-list", total: 1 });
  });
});

describe("mutations trigger re-ingestion", () => {
  it("create ingests with documents", async () => {
    prismaMock.knowledgeDocument.create.mockResolvedValue({ id: 9 });
    prismaMock.knowledgeDocument.findMany.mockResolvedValue([
      { id: 9, businessProfileId: 3, kind: "faq", title: "Q", content: "A" },
    ]);
    await createKnowledgeDocument(3, { kind: "faq", title: "Q", content: "A" });
    expect(agentClient.ingestRag).toHaveBeenCalledWith(expect.objectContaining({
      business_profile_id: 3, mode: "partial",
    }));
  });

  it("update + delete re-ingest and scope by profile", async () => {
    prismaMock.knowledgeDocument.findFirst.mockResolvedValue({ id: 9, businessProfileId: 3 });
    prismaMock.knowledgeDocument.update.mockResolvedValue({ id: 9 });
    prismaMock.knowledgeDocument.delete.mockResolvedValue({ id: 9 });
    prismaMock.knowledgeDocument.findMany.mockResolvedValue([]);
    await updateKnowledgeDocument(3, 9, { content: "new" });
    await deleteKnowledgeDocument(3, 9);
    expect(prismaMock.knowledgeDocument.findFirst).toHaveBeenCalledWith({
      where: { id: 9, businessProfileId: 3 },
    });
    expect(agentClient.ingestRag).toHaveBeenCalledTimes(2);
  });

  it("update rejects foreign document", async () => {
    prismaMock.knowledgeDocument.findFirst.mockResolvedValue(null);
    await expect(updateKnowledgeDocument(3, 999, { content: "x" })).rejects.toThrow("not found");
  });
});

describe("ingestProfileDocuments", () => {
  it("sends documents payload (no qdrant keys — graph reads env)", async () => {
    prismaMock.knowledgeDocument.findMany.mockResolvedValue([]);
    await ingestProfileDocuments(3);
    expect(agentClient.ingestRag).toHaveBeenCalledWith({
      business_profile_id: 3, documents: [], mode: "partial",
    });
  });
});
