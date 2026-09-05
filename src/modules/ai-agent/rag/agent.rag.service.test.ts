import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  $transaction: vi.fn(),
  ragIndexState: {
    upsert: vi.fn(),
    updateMany: vi.fn(),
    findUnique: vi.fn(),
  },
  knowledgeDocument: { findMany: vi.fn() },
}));
vi.mock("@config/prisma", () => ({ default: prismaMock }));

import { beginRagRefresh, commitRagRefresh, getActiveRagRevision } from "./agent.rag.service";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (fn: any) => fn(prismaMock));
});

describe("beginRagRefresh", () => {
  it("reserves a revision and reads canonical documents in one repeatable-read transaction", async () => {
    prismaMock.ragIndexState.upsert.mockResolvedValue({ requestedRevision: 6 });
    prismaMock.knowledgeDocument.findMany.mockResolvedValue([
      { id: 10, businessProfileId: 99, kind: "faq", title: "Returns", content: "14 days" },
    ]);

    const result = await beginRagRefresh(3);

    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "RepeatableRead",
    });
    expect(prismaMock.ragIndexState.upsert).toHaveBeenCalledWith({
      where: { businessProfileId: 3 },
      create: { businessProfileId: 3, requestedRevision: 1 },
      update: { requestedRevision: { increment: 1 } },
      select: { requestedRevision: true },
    });
    expect(prismaMock.knowledgeDocument.findMany).toHaveBeenCalledWith({
      where: { businessProfileId: 3 },
      orderBy: { id: "asc" },
      select: { id: true, businessProfileId: true, kind: true, title: true, content: true },
    });
    expect(result).toEqual({
      revision: 6,
      documents: [{ id: 10, business_profile_id: 3, kind: "faq", title: "Returns", content: "14 days" }],
    });
  });

  it("retries a revision reservation after a database write conflict", async () => {
    prismaMock.$transaction
      .mockRejectedValueOnce(Object.assign(new Error("write conflict"), { code: "P2034" }))
      .mockImplementationOnce(async (fn: any) => fn(prismaMock));
    prismaMock.ragIndexState.upsert.mockResolvedValue({ requestedRevision: 8 });
    prismaMock.knowledgeDocument.findMany.mockResolvedValue([]);

    await expect(beginRagRefresh(3)).resolves.toEqual({ revision: 8, documents: [] });
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
  });
});

describe("commitRagRefresh", () => {
  it("publishes only the latest requested revision", async () => {
    prismaMock.ragIndexState.updateMany.mockResolvedValue({ count: 1 });
    const result = await commitRagRefresh(3, 6);
    expect(prismaMock.ragIndexState.updateMany).toHaveBeenCalledWith({
      where: { businessProfileId: 3, requestedRevision: 6 },
      data: { activeRevision: 6 },
    });
    expect(result).toEqual({ published: true, active_revision: 6 });
  });

  it("refuses an older overlapping revision and reports the committed revision", async () => {
    prismaMock.ragIndexState.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.ragIndexState.findUnique.mockResolvedValue({ activeRevision: 7 });
    const result = await commitRagRefresh(3, 6);
    expect(result).toEqual({ published: false, active_revision: 7 });
  });

  it("treats a repeated commit for the active revision as idempotently published", async () => {
    prismaMock.ragIndexState.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.ragIndexState.findUnique.mockResolvedValue({ activeRevision: 6 });

    await expect(commitRagRefresh(3, 6)).resolves.toEqual({
      published: true,
      active_revision: 6,
    });
  });
});

describe("getActiveRagRevision", () => {
  it("returns null before the first successful publication", async () => {
    prismaMock.ragIndexState.findUnique.mockResolvedValue({ activeRevision: null });
    await expect(getActiveRagRevision(3)).resolves.toEqual({ active_revision: null });
  });
});
