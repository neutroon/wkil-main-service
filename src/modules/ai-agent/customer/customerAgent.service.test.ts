import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  conversation: {
    updateMany: vi.fn(),
    findFirstOrThrow: vi.fn(),
  },
  conversationMessage: { findMany: vi.fn() },
  agentTurn: { upsert: vi.fn(), findUniqueOrThrow: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
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

import { executeCustomerTurn, prepareCustomerTurn } from "./customerAgent.service";

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
    ...overrides,
  };
}

describe("customer agent coordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.conversation.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.conversation.findFirstOrThrow.mockResolvedValue(conversation());
    prismaMock.conversationMessage.findMany.mockResolvedValue([]);
    prismaMock.agentTurn.upsert.mockResolvedValue({ id: 8, agentRunId: null, status: "RUNNING" });
    prismaMock.agentTurn.findUniqueOrThrow.mockResolvedValue({ id: 8, agentRunId: runId });
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

    expect(randomUUID).toHaveBeenCalledOnce();
    expect(prismaMock.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 45, businessProfileId: 10, agentThreadId: null },
      data: { agentThreadId: threadId },
    });
    expect(prismaMock.conversation.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: 45, businessProfileId: 10 },
      select: { id: true, businessProfileId: true, agentThreadId: true, agentHistorySeededAt: true },
    });
    expect(agentClientMock.ensureCustomerThread).toHaveBeenCalledWith(
      threadId,
      { businessProfileId: 10, conversationId: 45, channel: "whatsapp" },
      undefined,
    );
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
    prismaMock.agentTurn.upsert.mockResolvedValue({ id: 8, agentRunId: runId, status: "RUNNING" });

    const result = await executeCustomerTurn(baseParams);

    expect(agentClientMock.startCustomerRun).not.toHaveBeenCalled();
    expect(agentClientMock.joinCustomerRun).toHaveBeenCalledWith(threadId, runId, { signal: undefined });
    expect(result).toMatchObject({ agentTurnId: 8, threadId, runId, decision: { action: "REPLY" } });
  });

  it("recovers a run created before the database run ID update", async () => {
    agentClientMock.findCustomerRunByDedupeKey.mockResolvedValue({ runId });

    const result = await prepareCustomerTurn(baseParams);

    expect(agentClientMock.startCustomerRun).not.toHaveBeenCalled();
    expect(prismaMock.agentTurn.updateMany).toHaveBeenCalledWith({
      where: { id: 8, agentRunId: null }, data: { agentRunId: runId },
    });
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
