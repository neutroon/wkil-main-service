import { beforeEach, describe, expect, it, vi } from "vitest";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));

vi.mock("@utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@modules/ai-agent/core/modelRuntime", () => ({ streamDecisionOrTool: streamMock }));
vi.mock("@modules/realtime/socket", () => ({ emitToCopilot: vi.fn() }));
vi.mock("@modules/ai-agent/core/checkpointer", () => ({ checkpointer: undefined }));
vi.mock("./copilot.store", () => ({
  getCopilotConversationForUser: vi.fn(async () => ({ id: 7, userId: 5, kind: "GENERAL", onboardingStep: "done", summary: null })),
  listCopilotMessages: vi.fn(async () => []),
}));
const handlerMock = vi.fn(async () => ({ totalMessages: 10 }));
vi.mock("./copilot.tools/index", () => ({
  findCopilotTool: vi.fn(() => ({ name: "get_overview_stats", schema: { parse: (v: unknown) => v }, requiresConfirmation: false, handler: handlerMock })),
  copilotTools: [],
}));

import { runCopilotGraph } from "./copilot.graph";

describe("runCopilotGraph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamMock
      .mockResolvedValueOnce({ toolCalls: [{ id: "t1", name: "get_overview_stats", args: { days: 30 } }], rawText: "", usage: { promptTokens: 3, completionTokens: 1, groundingCalls: 0 }, modelName: "m", finishReason: "STOP" })
      .mockResolvedValueOnce({ toolCalls: [], rawText: "Here is your overview.", usage: { promptTokens: 5, completionTokens: 4, groundingCalls: 0 }, modelName: "m", finishReason: "STOP" });
  });

  it("runs tool loop then returns card + text envelopes", async () => {
    const out = await runCopilotGraph({ conversationId: 7, userId: 5, locale: "en", text: "show stats" });
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(handlerMock).toHaveBeenCalled();
    expect(out.envelopes.map((e) => e.type)).toEqual(expect.arrayContaining(["stat-grid", "text"]));
    expect(out.usage.promptTokens).toBe(8);
  });

  it("stops after 5 tool rounds", async () => {
    streamMock.mockReset();
    streamMock.mockResolvedValue({ toolCalls: [{ id: "t", name: "get_overview_stats", args: {} }], rawText: "", usage: { promptTokens: 1, completionTokens: 0, groundingCalls: 0 }, modelName: "m", finishReason: "STOP" });
    const out = await runCopilotGraph({ conversationId: 7, userId: 5, locale: "en", text: "loop" });
    expect(streamMock.mock.calls.length).toBeLessThanOrEqual(6);
    expect(out.envelopes.some((e) => e.type === "error")).toBe(true);
  });
});
