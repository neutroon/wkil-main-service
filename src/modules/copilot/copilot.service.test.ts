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
}));
vi.mock("./copilot.graph", () => ({ runCopilotGraph: runGraphMock }));
vi.mock("@modules/realtime/socket", () => ({ emitToCopilot: emitMock }));
vi.mock("@modules/billing/billing.service", () => ({ assertQuotaAvailable: assertQuotaMock, recordAiUsage: recordUsageMock }));

import { AppError } from "@middlewares/errorHandler.middleware";
import { runCopilotTurn } from "./copilot.service";

describe("runCopilotTurn", () => {
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

  it("persists user + assistant messages, emits, and records usage", async () => {
    const out = await runCopilotTurn({ userId: 5, text: "مرحبا", locale: "ar" });
    expect(assertQuotaMock).toHaveBeenCalledWith(5, undefined);
    expect(out).toMatchObject({ ok: true, conversationId: 7, envelopes: [{ type: "text" }] });
    expect(emitMock).toHaveBeenCalledWith(5, "copilot:message", expect.objectContaining({ conversationId: 7 }));
    expect(recordUsageMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 5, operation: "copilot_chat", promptTokens: 3, conversationId: "7",
    }));
  });

  it("persists expectedTotal when truncated", async () => {
    runGraphMock.mockResolvedValueOnce({
      envelopes: [{ type: "stat-grid", items: [] }],
      usage: { promptTokens: 1, completionTokens: 1 },
      modelName: "gemini-2.5-flash",
      truncated: true,
      expectedTotal: 4,
    });
    await runCopilotTurn({ userId: 5, text: "مرحبا", locale: "ar" });
    const { appendCopilotMessage } = await import("./copilot.store");
    const calls = (appendCopilotMessage as any).mock.calls;
    const assistant = calls.find((c: any[]) => c[0]?.role === "ASSISTANT");
    expect(assistant[0].envelope).toMatchObject({ truncated: true, expectedTotal: 4 });
  });

  it("omits expectedTotal from the persisted envelope when not truncated", async () => {
    await runCopilotTurn({ userId: 5, text: "مرحبا", locale: "ar" });
    const { appendCopilotMessage } = await import("./copilot.store");
    const calls = (appendCopilotMessage as any).mock.calls;
    const assistant = calls.find((c: any[]) => c[0]?.role === "ASSISTANT");
    expect(assistant[0].envelope).not.toHaveProperty("expectedTotal");
  });

  it("propagates quota exhaustion as 402", async () => {
    assertQuotaMock.mockRejectedValueOnce(new AppError("quota", 402, true));
    await expect(runCopilotTurn({ userId: 5, text: "x", locale: "ar" })).rejects.toMatchObject({ statusCode: 402 });
  });

  it("returns ok: false on graph failure without persisting an assistant message", async () => {
    runGraphMock.mockRejectedValueOnce(new Error("provider down"));
    const out = await runCopilotTurn({ userId: 5, text: "x", locale: "ar" });
    expect(out).toMatchObject({ ok: false, retryable: true });
    // User message should still be persisted, but assistant message should NOT be:
    const { appendCopilotMessage } = await import("./copilot.store");
    const calls = (appendCopilotMessage as any).mock.calls;
    const assistantCalls = calls.filter((c: any[]) => c[0]?.role === "ASSISTANT");
    expect(assistantCalls).toHaveLength(0);
  });
});
