import { beforeEach, describe, expect, it, vi } from "vitest";

const { runGraphMock, assertQuotaMock, recordUsageMock, emitMock } = vi.hoisted(() => ({
  runGraphMock: vi.fn(),
  assertQuotaMock: vi.fn(),
  recordUsageMock: vi.fn(),
  emitMock: vi.fn(),
}));

vi.mock("@utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("./copilot.store", () => ({
  getOrCreateCopilotConversation: vi.fn(async () => ({ id: 7, userId: 5, kind: "GENERAL" })),
  getCopilotConversationForUser: vi.fn(async () => ({ id: 7, userId: 5, kind: "GENERAL" })),
  appendCopilotMessage: vi.fn(async () => ({ id: 100 })),
  listCopilotMessages: vi.fn(async () => []),
  getCopilotMessageById: vi.fn(async () => null),
  deleteCopilotMessagesAfter: vi.fn(async () => undefined),
}));
vi.mock("./copilot.graph", () => ({ runCopilotGraph: runGraphMock }));
vi.mock("@modules/realtime/socket", () => ({ emitToCopilot: emitMock }));
vi.mock("@modules/billing/billing.service", () => ({ assertQuotaAvailable: assertQuotaMock, recordAiUsage: recordUsageMock }));

import { AppError } from "@middlewares/errorHandler.middleware";
import { activeRuns, cancelCopilotRun, startCopilotTurn } from "./copilot.service";

async function waitForBackground(runId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (!activeRuns.has(runId)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`background runner for ${runId} did not finish in time`);
}

describe("startCopilotTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runGraphMock.mockResolvedValue({
      envelopes: [{ type: "text", text: "أهلاً" }],
      usage: { promptTokens: 3, completionTokens: 2 },
      modelName: "gemini-2.5-flash",
      truncated: false,
      expectedTotal: null,
    });
  });

  it("returns { runId, conversationId } synchronously and does not await the graph", async () => {
    const out = await startCopilotTurn({ userId: 5, text: "مرحبا", locale: "ar" });
    expect(out.runId).toMatch(/^[0-9a-f-]{36}$/); // UUID v4-ish
    expect(out.conversationId).toBe(7);
    // runId is registered in activeRuns
    expect(activeRuns.has(out.runId)).toBe(true);
    // clean up the background so it doesn't leak into other tests
    await waitForBackground(out.runId);
  });

  it("registers the run with the caller's userId", async () => {
    const out = await startCopilotTurn({ userId: 5, text: "x", locale: "ar" });
    const run = activeRuns.get(out.runId);
    expect(run?.userId).toBe(5);
    expect(run?.conversationId).toBe(7);
    expect(run?.abortController).toBeInstanceOf(AbortController);
    await waitForBackground(out.runId);
  });

  it("persists the user message", async () => {
    const out = await startCopilotTurn({ userId: 5, text: "hello", locale: "en" });
    await waitForBackground(out.runId);
    const { appendCopilotMessage } = await import("./copilot.store");
    const calls = (appendCopilotMessage as any).mock.calls;
    const userCall = calls.find((c: any[]) => c[0]?.role === "USER");
    expect(userCall[0].envelope).toMatchObject({ type: "text", text: "hello" });
  });

  it("persists user + assistant messages, emits copilot:message, and records usage", async () => {
    const out = await startCopilotTurn({ userId: 5, text: "مرحبا", locale: "ar" });
    await waitForBackground(out.runId);
    expect(assertQuotaMock).toHaveBeenCalledWith(5, undefined);
    expect(emitMock).toHaveBeenCalledWith(5, "copilot:message", expect.objectContaining({
      runId: out.runId,
      conversationId: 7,
      envelopes: [{ type: "text", text: "أهلاً" }],
    }));
    expect(recordUsageMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 5, operation: "copilot_chat", promptTokens: 3, conversationId: "7",
    }));
    const { appendCopilotMessage } = await import("./copilot.store");
    const calls = (appendCopilotMessage as any).mock.calls;
    expect(calls.find((c: any[]) => c[0]?.role === "USER")).toBeTruthy();
    expect(calls.find((c: any[]) => c[0]?.role === "ASSISTANT")).toBeTruthy();
  });

  it("persists expectedTotal when truncated", async () => {
    runGraphMock.mockResolvedValueOnce({
      envelopes: [{ type: "stat-grid", items: [] }],
      usage: { promptTokens: 1, completionTokens: 1 },
      modelName: "gemini-2.5-flash",
      truncated: true,
      expectedTotal: 4,
    });
    const out = await startCopilotTurn({ userId: 5, text: "مرحبا", locale: "ar" });
    await waitForBackground(out.runId);
    const { appendCopilotMessage } = await import("./copilot.store");
    const calls = (appendCopilotMessage as any).mock.calls;
    const assistant = calls.find((c: any[]) => c[0]?.role === "ASSISTANT");
    expect(assistant[0].envelope).toMatchObject({ truncated: true, expectedTotal: 4 });
  });

  it("omits expectedTotal from the persisted envelope when not truncated", async () => {
    const out = await startCopilotTurn({ userId: 5, text: "مرحبا", locale: "ar" });
    await waitForBackground(out.runId);
    const { appendCopilotMessage } = await import("./copilot.store");
    const calls = (appendCopilotMessage as any).mock.calls;
    const assistant = calls.find((c: any[]) => c[0]?.role === "ASSISTANT");
    expect(assistant[0].envelope).not.toHaveProperty("expectedTotal");
  });

  it("throws quota exhaustion synchronously and persists no user message", async () => {
    assertQuotaMock.mockRejectedValueOnce(new AppError("quota", 402, true));
    await expect(startCopilotTurn({ userId: 5, text: "x", locale: "ar" })).rejects.toMatchObject({ statusCode: 402 });
    const { appendCopilotMessage } = await import("./copilot.store");
    const calls = (appendCopilotMessage as any).mock.calls;
    expect(calls).toHaveLength(0);
  });

  it("emits copilot:error and persists no assistant message on graph failure", async () => {
    runGraphMock.mockRejectedValueOnce(new Error("provider down"));
    const out = await startCopilotTurn({ userId: 5, text: "x", locale: "ar" });
    await waitForBackground(out.runId);
    expect(emitMock).toHaveBeenCalledWith(5, "copilot:error", expect.objectContaining({
      runId: out.runId,
      conversationId: 7,
      message: "The service is unavailable right now.",
    }));
    const { appendCopilotMessage } = await import("./copilot.store");
    const calls = (appendCopilotMessage as any).mock.calls;
    const assistantCalls = calls.filter((c: any[]) => c[0]?.role === "ASSISTANT");
    expect(assistantCalls).toHaveLength(0);
  });

  it("emits copilot:cancelled (not copilot:error) when the run is aborted mid-graph", async () => {
    const abortError: any = new Error("aborted");
    abortError.name = "AbortError";
    runGraphMock.mockImplementationOnce(async (params: any) => {
      // simulate the graph honoring the abort signal
      if (params.signal) {
        await new Promise<void>((resolve, reject) => {
          params.signal.addEventListener("abort", () => reject(abortError));
        });
      }
      return {
        envelopes: [{ type: "text", text: "أهلاً" }],
        usage: { promptTokens: 3, completionTokens: 2 },
        modelName: "gemini-2.5-flash",
        truncated: false,
        expectedTotal: null,
      };
    });
    const out = await startCopilotTurn({ userId: 5, text: "x", locale: "ar" });
    // abort the run before the graph finishes
    const cancelOut = await cancelCopilotRun(out.runId, 5);
    expect(cancelOut.cancelled).toBe(true);
    await waitForBackground(out.runId);
    expect(emitMock).toHaveBeenCalledWith(5, "copilot:cancelled", expect.objectContaining({
      runId: out.runId,
      conversationId: 7,
    }));
    expect(emitMock).not.toHaveBeenCalledWith(5, "copilot:error", expect.anything());
    const { appendCopilotMessage } = await import("./copilot.store");
    const calls = (appendCopilotMessage as any).mock.calls;
    const assistantCalls = calls.filter((c: any[]) => c[0]?.role === "ASSISTANT");
    expect(assistantCalls).toHaveLength(0);
  });
});

describe("startCopilotRegenerate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runGraphMock.mockResolvedValue({
      envelopes: [{ type: "text", text: "أهلاً" }],
      usage: { promptTokens: 3, completionTokens: 2 },
      modelName: "gemini-2.5-flash",
      truncated: false,
      expectedTotal: null,
    });
  });

  it("returns { runId, conversationId } for a valid parent with an assistant child", async () => {
    const { startCopilotRegenerate } = await import("./copilot.service");
    const { getCopilotMessageById, listCopilotMessages } = await import("./copilot.store");
    const parent = { id: 41, role: "USER", conversationId: 7, createdAt: new Date("2026-08-24T10:00:00Z"), envelope: { type: "text", text: "hello" } };
    (getCopilotMessageById as any).mockResolvedValueOnce(parent);
    (listCopilotMessages as any).mockResolvedValueOnce([
      parent,
      { ...parent, id: 42, role: "ASSISTANT", createdAt: new Date("2026-08-24T10:00:01Z") },
    ]);
    const out = await startCopilotRegenerate({ userId: 5, userMsgId: 41, locale: "ar" });
    expect(out.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.conversationId).toBe(7);
    await waitForBackground(out.runId);
  });

  it("throws AppError(404) when parent not found", async () => {
    const { startCopilotRegenerate } = await import("./copilot.service");
    const { getCopilotMessageById } = await import("./copilot.store");
    (getCopilotMessageById as any).mockResolvedValueOnce(null);
    await expect(startCopilotRegenerate({ userId: 5, userMsgId: 99, locale: "ar" }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("throws AppError(422) when parent exists but no assistant child", async () => {
    const { startCopilotRegenerate } = await import("./copilot.service");
    const { getCopilotMessageById, listCopilotMessages } = await import("./copilot.store");
    (getCopilotMessageById as any).mockResolvedValueOnce({
      id: 41, role: "USER", conversationId: 7, createdAt: new Date("2026-08-24T10:00:00Z"), envelope: { type: "text", text: "hello" },
    });
    (listCopilotMessages as any).mockResolvedValueOnce([
      { id: 41, role: "USER", conversationId: 7, createdAt: new Date("2026-08-24T10:00:00Z"), envelope: {} },
    ]);
    await expect(startCopilotRegenerate({ userId: 5, userMsgId: 41, locale: "ar" }))
      .rejects.toMatchObject({ statusCode: 422 });
  });

  it("throws AppError(422) when parent exists but is not a USER message", async () => {
    const { startCopilotRegenerate } = await import("./copilot.service");
    const { getCopilotMessageById } = await import("./copilot.store");
    (getCopilotMessageById as any).mockResolvedValueOnce({
      id: 41,
      role: "ASSISTANT",
      conversationId: 7,
      createdAt: new Date("2026-08-24T10:00:00Z"),
      envelope: { type: "text", text: "hi" },
    });
    await expect(startCopilotRegenerate({ userId: 5, userMsgId: 41, locale: "ar" }))
      .rejects.toMatchObject({ statusCode: 422 });
  });
});

describe("cancelCopilotRun", () => {
  beforeEach(() => {
    activeRuns.clear();
  });

  it("returns { cancelled: false } for an unknown runId", async () => {
    const out = await cancelCopilotRun("nonexistent-id", 5);
    expect(out).toEqual({ cancelled: false });
  });

  it("returns { cancelled: true } and aborts when runId is registered", async () => {
    const controller = new AbortController();
    activeRuns.set("test-run-id", {
      abortController: controller,
      conversationId: 7,
      userId: 5,
    });
    const out = await cancelCopilotRun("test-run-id", 5);
    expect(out).toEqual({ cancelled: true });
    expect(controller.signal.aborted).toBe(true);
    expect(activeRuns.has("test-run-id")).toBe(false);
  });

  it("returns { cancelled: false } when runId belongs to another user", async () => {
    const controller = new AbortController();
    activeRuns.set("other-user-run", {
      abortController: controller,
      conversationId: 7,
      userId: 99,
    });
    const out = await cancelCopilotRun("other-user-run", 5);
    expect(out).toEqual({ cancelled: false });
    expect(controller.signal.aborted).toBe(false);
    expect(activeRuns.has("other-user-run")).toBe(true);
  });
});
