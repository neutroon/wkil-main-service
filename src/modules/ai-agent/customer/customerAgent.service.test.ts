import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  conversation: {
    updateMany: vi.fn(),
    findFirstOrThrow: vi.fn(),
  },
  conversationMessage: { findMany: vi.fn() },
  agentTurn: { findUnique: vi.fn(), upsert: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
}));
const agentClientMock = vi.hoisted(() => ({
  ensureCustomerThread: vi.fn(),
  getCustomerThreadState: vi.fn(),
  findCustomerRunByDedupeKey: vi.fn(),
  startCustomerRun: vi.fn(),
  joinCustomerRun: vi.fn(),
}));

vi.mock("@config/prisma", () => ({ default: prismaMock }));
vi.mock("@modules/ai-agent/client/agent.client", () => ({ AgentClient: agentClientMock }));

import {
  executeCustomerTurn,
  finalizeCustomerTurn,
  prepareCustomerTurn,
} from "./customerAgent.service";

const threadId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const baseParams = {
  userId: 7,
  businessProfileId: 10,
  conversationId: 45,
  channel: "whatsapp" as const,
  inputMessageId: 99,
  customerText: "Hello",
  runMode: "inbound" as const,
  dedupeKey: "message:99",
  mediaContext: null,
};

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 45,
    businessProfileId: 10,
    agentThreadId: threadId,
    agentHistorySeededAt: null,
    agentSeedLeaseOwner: null,
    agentSeedLeaseExpiresAt: null,
    ...overrides,
  };
}

describe("customer agent coordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.conversation.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.conversation.findFirstOrThrow.mockResolvedValue(conversation());
    prismaMock.conversationMessage.findMany.mockResolvedValue([]);
    prismaMock.agentTurn.findUnique.mockResolvedValue(null);
    prismaMock.agentTurn.upsert.mockResolvedValue({
      id: 8, businessProfileId: 10, conversationId: 45, channel: "whatsapp",
      agentRunId: null, status: "RUNNING",
    });
    prismaMock.agentTurn.findUniqueOrThrow.mockResolvedValue({
      id: 8, businessProfileId: 10, conversationId: 45, channel: "whatsapp",
      agentRunId: runId, status: "RUNNING", decision: null,
    });
    prismaMock.agentTurn.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.agentTurn.update.mockResolvedValue({ id: 8 });
    agentClientMock.ensureCustomerThread.mockResolvedValue(undefined);
    agentClientMock.getCustomerThreadState.mockResolvedValue({ messages: [] });
    agentClientMock.findCustomerRunByDedupeKey.mockResolvedValue(null);
    agentClientMock.startCustomerRun.mockResolvedValue({ runId });
    agentClientMock.joinCustomerRun.mockResolvedValue({
      action: "REPLY", content: "Welcome", reason_code: "KNOWLEDGE_MATCH", handoff_category: null,
    });
  });

  it("compare-and-sets a thread ID, reloads it in tenant scope, and creates it idempotently", async () => {
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockReturnValue(threadId);

    await prepareCustomerTurn(baseParams);

    expect(randomUUID).toHaveBeenCalled();
    expect(prismaMock.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 45, businessProfileId: 10, agentThreadId: null },
      data: { agentThreadId: threadId },
    });
    expect(prismaMock.conversation.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: 45, businessProfileId: 10 },
      select: {
        id: true, businessProfileId: true, agentThreadId: true, agentHistorySeededAt: true,
        agentSeedLeaseOwner: true, agentSeedLeaseExpiresAt: true,
      },
    });
    expect(agentClientMock.ensureCustomerThread).toHaveBeenCalledWith(
      threadId,
      { businessProfileId: 10, conversationId: 45, channel: "whatsapp" },
      undefined,
    );
  });

  it("namespaces the caller dedupe key by tenant, conversation, and channel before persistence", async () => {
    await prepareCustomerTurn(baseParams);

    expect(prismaMock.agentTurn.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { dedupeKey: "customer:10:45:whatsapp:message%3A99" },
      create: expect.objectContaining({ dedupeKey: "customer:10:45:whatsapp:message%3A99" }),
    }));
  });

  it("keeps identical caller keys isolated across tenant scopes", async () => {
    prismaMock.conversation.findFirstOrThrow
      .mockResolvedValueOnce(conversation())
      .mockResolvedValueOnce(conversation({ id: 46, businessProfileId: 11 }));
    prismaMock.agentTurn.upsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => ({
      id: 8,
      businessProfileId: create.businessProfileId,
      conversationId: create.conversationId,
      channel: create.channel,
      agentRunId: null,
      status: "RUNNING",
    }));

    await prepareCustomerTurn(baseParams);
    await prepareCustomerTurn({ ...baseParams, businessProfileId: 11, conversationId: 46 });

    expect(prismaMock.agentTurn.upsert).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { dedupeKey: "customer:10:45:whatsapp:message%3A99" },
    }));
    expect(prismaMock.agentTurn.upsert).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { dedupeKey: "customer:11:46:whatsapp:message%3A99" },
    }));
  });

  it("refuses a turn returned from a different tenant scope", async () => {
    prismaMock.agentTurn.upsert.mockResolvedValue({
      id: 8, businessProfileId: 11, conversationId: 45, channel: "whatsapp",
      agentRunId: null, status: "RUNNING",
    });

    await expect(prepareCustomerTurn(baseParams)).rejects.toThrow("does not belong to this conversation scope");
    expect(agentClientMock.startCustomerRun).not.toHaveBeenCalled();
  });

  it("claims a durable turn lease before creating a remote run", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(threadId)
      .mockReturnValueOnce("33333333-3333-4333-8333-333333333333");

    await prepareCustomerTurn(baseParams);

    expect(prismaMock.agentTurn.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 8,
        agentRunId: null,
        OR: expect.any(Array),
      }),
      data: expect.objectContaining({
        runLeaseOwner: "33333333-3333-4333-8333-333333333333",
        runLeaseExpiresAt: expect.any(Date),
      }),
    }));
  });

  it("claims a durable conversation seed lease before the first run", async () => {
    await prepareCustomerTurn(baseParams);

    expect(prismaMock.conversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 45,
        businessProfileId: 10,
        OR: expect.any(Array),
      }),
      data: expect.objectContaining({
        agentSeedLeaseOwner: expect.any(String),
        agentSeedLeaseExpiresAt: expect.any(Date),
      }),
    }));
  });

  it("does not start a duplicate remote run when another worker owns the durable run lease", async () => {
    prismaMock.agentTurn.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.agentTurn.findUniqueOrThrow.mockResolvedValue({
      id: 8, businessProfileId: 10, conversationId: 45, channel: "whatsapp",
      agentRunId: null, status: "RUNNING", decision: null,
    });

    await expect(prepareCustomerTurn(baseParams)).rejects.toMatchObject({ code: "CUSTOMER_AGENT_LEASE_BUSY" });
    expect(agentClientMock.startCustomerRun).not.toHaveBeenCalled();
  });

  it("releases its run lease when a distinct concurrent turn is waiting for the conversation seed lease", async () => {
    prismaMock.conversation.updateMany.mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      if ("agentSeedLeaseOwner" in data) return Promise.resolve({ count: 0 });
      return Promise.resolve({ count: 1 });
    });

    await expect(prepareCustomerTurn({ ...baseParams, dedupeKey: "message:100" }))
      .rejects.toMatchObject({ code: "CUSTOMER_AGENT_LEASE_BUSY" });

    expect(prismaMock.agentTurn.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 8, agentRunId: null, runLeaseOwner: expect.any(String) }),
      data: { runLeaseOwner: null, runLeaseExpiresAt: null },
    }));
    expect(agentClientMock.startCustomerRun).not.toHaveBeenCalled();
  });

  it("keeps the seed lease while the initial run is queued so a distinct turn cannot reseed", async () => {
    let seedClaims = 0;
    prismaMock.conversation.updateMany.mockImplementation(({ data }: { data: Record<string, unknown> }) => {
      if (data.agentSeedLeaseOwner && data.agentSeedLeaseExpiresAt instanceof Date) {
        seedClaims += 1;
        return Promise.resolve({ count: seedClaims === 1 ? 1 : 0 });
      }
      return Promise.resolve({ count: 1 });
    });

    const first = await prepareCustomerTurn(baseParams);

    await expect(prepareCustomerTurn({ ...baseParams, dedupeKey: "message:100" }))
      .rejects.toMatchObject({ code: "CUSTOMER_AGENT_LEASE_BUSY" });

    expect(first.seedLeaseOwner).toEqual(expect.any(String));
    expect(prismaMock.conversationMessage.findMany).toHaveBeenCalledOnce();
    expect(agentClientMock.startCustomerRun).toHaveBeenCalledOnce();
  });

  it("releases the claimed history lease when thread-state recovery fails", async () => {
    agentClientMock.getCustomerThreadState.mockRejectedValueOnce(new Error("state unavailable"));

    await expect(prepareCustomerTurn(baseParams)).rejects.toThrow("state unavailable");

    expect(prismaMock.conversation.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 45,
        businessProfileId: 10,
        agentSeedLeaseOwner: expect.any(String),
      }),
      data: { agentSeedLeaseOwner: null, agentSeedLeaseExpiresAt: null },
    }));
  });

  it("aborts a slow create before its lease expires and blocks a retry from creating a duplicate", async () => {
    vi.useFakeTimers();
    try {
      let runLeaseClaims = 0;
      prismaMock.agentTurn.updateMany.mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        if (data.runLeaseOwner && data.runLeaseExpiresAt instanceof Date) {
          runLeaseClaims += 1;
          return Promise.resolve({ count: runLeaseClaims === 1 ? 1 : 0 });
        }
        return Promise.resolve({ count: 1 });
      });
      agentClientMock.startCustomerRun.mockImplementationOnce(({ signal }: { signal?: AbortSignal }) => (
        new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }))
      ));
      prismaMock.agentTurn.findUniqueOrThrow.mockResolvedValue({
        id: 8, businessProfileId: 10, conversationId: 45, channel: "whatsapp",
        agentRunId: null, status: "RUNNING", decision: null,
      });

      const first = prepareCustomerTurn({ ...baseParams, dedupeKey: "slow-create" });
      const firstOutcome = expect(first).rejects.toThrow("Customer agent run creation timed out");
      await vi.waitFor(() => expect(agentClientMock.startCustomerRun).toHaveBeenCalledOnce());

      const createSignal = agentClientMock.startCustomerRun.mock.calls[0][0].signal as AbortSignal;
      expect(createSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      await firstOutcome;
      expect(createSignal.aborted).toBe(true);

      await expect(prepareCustomerTurn({ ...baseParams, dedupeKey: "slow-create" }))
        .rejects.toMatchObject({ code: "CUSTOMER_AGENT_LEASE_BUSY" });
      expect(agentClientMock.startCustomerRun).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reclaims an expired conversation seed lease before seeding a new thread", async () => {
    prismaMock.conversation.findFirstOrThrow.mockResolvedValue(conversation({
      agentSeedLeaseOwner: "33333333-3333-4333-8333-333333333333",
      agentSeedLeaseExpiresAt: new Date("2026-09-01T00:00:00.000Z"),
    }));

    await prepareCustomerTurn(baseParams);

    expect(prismaMock.conversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([expect.objectContaining({ agentSeedLeaseExpiresAt: expect.objectContaining({ lt: expect.any(Date) }) })]),
      }),
    }));
    expect(agentClientMock.startCustomerRun).toHaveBeenCalledOnce();
  });

  it("seeds at most the newest 24 messages in chronological order and maps roles", async () => {
    prismaMock.conversationMessage.findMany.mockResolvedValue([
      { id: 3, role: "agent", content: "newest agent" },
      { id: 2, role: "model", content: "newer model" },
      { id: 1, role: "user", content: "older user" },
    ]);

    await prepareCustomerTurn(baseParams);

    expect(prismaMock.conversationMessage.findMany).toHaveBeenCalledWith({
      where: { conversationId: 45, NOT: { id: 99 } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 24,
      select: { id: true, role: true, content: true },
    });
    expect(agentClientMock.startCustomerRun).toHaveBeenCalledWith(expect.objectContaining({
      messages: [
        { role: "user", content: "older user" },
        { role: "assistant", content: "newer model" },
        { role: "assistant", content: "newest agent" },
        { role: "user", content: "Hello" },
      ],
    }));
  });

  it("rejoins a persisted run instead of generating a second run on retry", async () => {
    prismaMock.agentTurn.upsert.mockResolvedValue({
      id: 8, businessProfileId: 10, conversationId: 45, channel: "whatsapp",
      agentRunId: runId, status: "RUNNING",
    });

    const result = await executeCustomerTurn(baseParams);

    expect(agentClientMock.startCustomerRun).not.toHaveBeenCalled();
    expect(agentClientMock.joinCustomerRun).toHaveBeenCalledWith(threadId, runId, { signal: undefined });
    expect(result).toMatchObject({ agentTurnId: 8, threadId, runId, decision: { action: "REPLY" } });
  });

  it("recovers a run created before the database run ID update", async () => {
    agentClientMock.findCustomerRunByDedupeKey.mockResolvedValue({ runId });

    const result = await prepareCustomerTurn(baseParams);

    expect(agentClientMock.startCustomerRun).not.toHaveBeenCalled();
    expect(prismaMock.agentTurn.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 8, agentRunId: null, runLeaseOwner: expect.any(String) }),
      data: { agentRunId: runId, runLeaseOwner: null, runLeaseExpiresAt: null },
    }));
    expect(result).toEqual({ agentTurnId: 8, threadId, runId });
  });

  it("coalesces simultaneous local prepares for the same dedupe key", async () => {
    let resolveRun: ((value: { runId: string }) => void) | undefined;
    agentClientMock.startCustomerRun.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRun = resolve;
    }));

    const first = prepareCustomerTurn(baseParams);
    const second = prepareCustomerTurn(baseParams);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(agentClientMock.startCustomerRun).toHaveBeenCalledOnce());
    resolveRun?.({ runId });

    await expect(first).resolves.toEqual({ agentTurnId: 8, threadId, runId });
    await expect(second).resolves.toEqual({ agentTurnId: 8, threadId, runId });
  });

  it("reseeds bounded history when a TTL-expired thread has no persisted messages", async () => {
    prismaMock.conversation.findFirstOrThrow.mockResolvedValue(conversation({
      agentHistorySeededAt: new Date("2026-09-01T00:00:00.000Z"),
    }));
    agentClientMock.getCustomerThreadState.mockResolvedValue({ values: {} });

    await prepareCustomerTurn(baseParams);

    expect(prismaMock.conversationMessage.findMany).toHaveBeenCalledOnce();
    expect(agentClientMock.startCustomerRun).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{ role: "user", content: "Hello" }],
    }));
  });

  it("persists a validated completed decision", async () => {
    await executeCustomerTurn(baseParams);

    expect(prismaMock.agentTurn.update).toHaveBeenCalledWith({
      where: { id: 8 },
      data: {
        decision: { action: "REPLY", content: "Welcome", reason_code: "KNOWLEDGE_MATCH", handoff_category: null },
        status: "COMPLETED",
        failureReason: null,
      },
    });
  });

  it("finalizes the initial seed claim after a terminal run, and does so idempotently", async () => {
    const handle = await prepareCustomerTurn(baseParams);

    const completedSeedCallsBefore = prismaMock.conversation.updateMany.mock.calls.filter(([{ data }]) => (
      data.agentHistorySeededAt instanceof Date && data.agentSeedLeaseOwner === null
    ));
    expect(completedSeedCallsBefore).toHaveLength(0);

    await finalizeCustomerTurn(baseParams, handle);
    prismaMock.conversation.updateMany.mockResolvedValueOnce({ count: 0 });
    await finalizeCustomerTurn(baseParams, handle);
    const callsAfterRepeat = prismaMock.conversation.updateMany.mock.calls.filter(([{ data }]) => (
      data.agentHistorySeededAt instanceof Date && data.agentSeedLeaseOwner === null
    ));
    expect(callsAfterRepeat).toHaveLength(2);
    expect(prismaMock.conversation.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { agentSeedLeaseOwner: null, agentSeedLeaseExpiresAt: null },
    }));
  });

  it("returns an already validated decision without joining a TTL-recreated remote run", async () => {
    prismaMock.agentTurn.findUnique.mockResolvedValue({
      id: 8, businessProfileId: 10, conversationId: 45, channel: "whatsapp", agentRunId: runId,
      status: "COMPLETED",
      decision: { action: "REPLY", content: "Welcome", reason_code: "KNOWLEDGE_MATCH", handoff_category: null },
    });

    await expect(executeCustomerTurn(baseParams)).resolves.toMatchObject({
      agentTurnId: 8, threadId, runId, decision: { action: "REPLY" },
    });
    expect(agentClientMock.ensureCustomerThread).not.toHaveBeenCalled();
    expect(agentClientMock.joinCustomerRun).not.toHaveBeenCalled();
    expect(prismaMock.agentTurn.upsert).not.toHaveBeenCalled();
  });

  it("persists a redacted failure before rethrowing", async () => {
    agentClientMock.joinCustomerRun.mockRejectedValue(new Error("provider token secret-value"));

    await expect(executeCustomerTurn(baseParams)).rejects.toThrow("provider token secret-value");

    expect(prismaMock.agentTurn.update).toHaveBeenCalledWith({
      where: { id: 8 },
      data: { status: "FAILED", failureReason: "CUSTOMER_AGENT_FAILURE" },
    });
  });

  it("does not mark a malformed Agent Server result as completed", async () => {
    agentClientMock.joinCustomerRun.mockResolvedValue({ action: "REPLY", content: null });

    await expect(executeCustomerTurn(baseParams)).rejects.toThrow();

    expect(prismaMock.agentTurn.update).toHaveBeenCalledWith({
      where: { id: 8 },
      data: { status: "FAILED", failureReason: "CUSTOMER_AGENT_FAILURE" },
    });
  });
});
