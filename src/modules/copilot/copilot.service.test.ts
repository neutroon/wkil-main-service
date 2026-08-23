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
    });
  });

  it("persists user + assistant messages, emits, and records usage", async () => {
    const out = await runCopilotTurn({ userId: 5, text: "مرحبا", locale: "ar" });
    expect(assertQuotaMock).toHaveBeenCalledWith(5, undefined);
    expect(out).toMatchObject({ conversationId: 7, envelopes: [{ type: "text" }] });
    expect(emitMock).toHaveBeenCalledWith(5, "copilot:message", expect.objectContaining({ conversationId: 7 }));
    expect(recordUsageMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 5, operation: "copilot_chat", promptTokens: 3, conversationId: "7",
    }));
  });

  it("propagates quota exhaustion as 402", async () => {
    assertQuotaMock.mockRejectedValueOnce(new AppError("quota", 402, true));
    await expect(runCopilotTurn({ userId: 5, text: "x", locale: "ar" })).rejects.toMatchObject({ statusCode: 402 });
  });

  it("returns an error envelope instead of throwing on graph failure", async () => {
    runGraphMock.mockRejectedValueOnce(new Error("provider down"));
    const out = await runCopilotTurn({ userId: 5, text: "x", locale: "ar" });
    expect(out.envelopes[0]).toMatchObject({ type: "error", retryable: true });
  });
});
