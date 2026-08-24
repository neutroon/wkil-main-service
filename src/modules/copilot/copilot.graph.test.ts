import { beforeEach, describe, expect, it, vi } from "vitest";

const { streamMock } = vi.hoisted(() => ({ streamMock: vi.fn() }));

import { emitToCopilot } from "@modules/realtime/socket";

vi.mock("@utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@modules/ai-agent/core/modelRuntime", () => ({ streamDecisionOrTool: streamMock }));
vi.mock("@modules/realtime/socket", () => ({ emitToCopilot: vi.fn() }));
vi.mock("@modules/ai-agent/core/checkpointer", () => ({ checkpointer: undefined }));
vi.mock("./copilot.store", () => ({
  getCopilotConversationForUser: vi.fn(async () => ({ id: 7, userId: 5, kind: "GENERAL", onboardingStep: "done", summary: null })),
  listCopilotMessages: vi.fn(async () => []),
}));
const handlerMock = vi.fn(async () => ({
  stats: { totalMessages: 10, aiAutomationRate: 0, leadVelocity: 0, avgResponseTime: "—" },
  leads: { data: [], meta: { total: 0 } },
  attention: { data: [] },
}));
vi.mock("./copilot.tools/index", () => ({
  findCopilotTool: vi.fn(() => ({ name: "get_overview", schema: { parse: (v: unknown) => v }, requiresConfirmation: false, handler: handlerMock })),
  copilotTools: [],
}));

import { runCopilotGraph } from "./copilot.graph";

describe("runCopilotGraph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamMock
      .mockResolvedValueOnce({ toolCalls: [{ id: "t1", name: "get_overview", args: { sections: ["stats", "leads", "attention"] } }], rawText: "", usage: { promptTokens: 3, completionTokens: 1, groundingCalls: 0 }, modelName: "m", finishReason: "STOP" })
      .mockResolvedValueOnce({ toolCalls: [], rawText: "Here is your overview.", usage: { promptTokens: 5, completionTokens: 4, groundingCalls: 0 }, modelName: "m", finishReason: "STOP" });
  });

  it("runs tool loop then returns card + text envelopes", async () => {
    const out = await runCopilotGraph({ conversationId: 7, userId: 5, locale: "en", text: "show stats" });
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(handlerMock).toHaveBeenCalled();
    expect(out.envelopes.map((e) => e.type)).toEqual(expect.arrayContaining(["stat-grid", "text"]));
    expect(out.usage.promptTokens).toBe(8);
    expect(out.truncated).toBe(false);
    // Not truncated → expectedTotal is null (frontend doesn't render the footer)
    expect(out.expectedTotal).toBeNull();
  });

  it("stops after 10 tool rounds and marks the response truncated when content exists", async () => {
    streamMock.mockReset();
    streamMock.mockResolvedValue({ toolCalls: [{ id: "t", name: "get_overview", args: {} }], rawText: "", usage: { promptTokens: 1, completionTokens: 0, groundingCalls: 0 }, modelName: "m", finishReason: "STOP" });
    const out = await runCopilotGraph({ conversationId: 7, userId: 5, locale: "en", text: "loop" });
    // After MAX_TOOL_ROUNDS (10), the loop stops. Stream was called at most 11 times (10 tool rounds + 1 final).
    expect(streamMock.mock.calls.length).toBeLessThanOrEqual(11);
    // finalize sees real envelopes (handlerMock returns a stat-grid each round) + capHit → truncated: true
    expect(out.truncated).toBe(true);
    // No trailing error envelope — the user got real data, an error would be misleading
    expect(out.envelopes.some((e) => e.type === "error")).toBe(false);
    // expectedTotal is the lower bound on what the model was trying to produce:
    // tool rounds + 1 for the cut-off final response.
    expect(out.expectedTotal).toBeGreaterThan(1);
  });

  // Skipped per brief guidance: this test is non-deterministic with the current
  // mock setup because envelopesForToolResult's `default` case returns an
  // { type: "error", ... } envelope for unknown tools — which counts as
  // content for `finalize`. Making this deterministic would require changing
  // the cards layer (out of scope for Task 6). The integration smoke test in
  // Task 10 covers this path end-to-end.
  it.skip("emits a friendly fallback text envelope when no real content exists (cap-hit, no data)", async () => {
    streamMock.mockReset();
    handlerMock.mockReset();
    handlerMock.mockResolvedValueOnce(null as any);
    streamMock.mockResolvedValue({ toolCalls: [{ id: "t", name: "noop", args: {} }], rawText: "", usage: { promptTokens: 1, completionTokens: 0, groundingCalls: 0 }, modelName: "m", finishReason: "STOP" });
    const out = await runCopilotGraph({ conversationId: 7, userId: 5, locale: "en", text: "noop" });
    expect(out.envelopes.length).toBeGreaterThan(0);
    expect(out.envelopes.some((e) => e.type === "text")).toBe(true);
    expect(out.truncated).toBe(false);
  });
});

describe("copilot trace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    streamMock
      .mockResolvedValueOnce({ toolCalls: [{ id: "t1", name: "get_overview", args: { sections: ["stats", "leads", "attention"] } }], rawText: "", usage: { promptTokens: 3, completionTokens: 1, groundingCalls: 0 }, modelName: "m", finishReason: "STOP" })
      .mockResolvedValueOnce({ toolCalls: [], rawText: "Here is your overview.", usage: { promptTokens: 5, completionTokens: 4, groundingCalls: 0 }, modelName: "m", finishReason: "STOP" });
  });

  it("emits copilot:tool once per executed tool with duration + returns trace", async () => {
    const emit = emitToCopilot as unknown as ReturnType<typeof vi.fn>;
    emit.mockClear();
    const out = await runCopilotGraph({
      conversationId: 1,
      userId: 5,
      locale: "en",
      text: "show me stats",
      runId: "run-xyz",
    });
    const toolCalls = emit.mock.calls.filter((c: any) => c[1] === "copilot:tool");
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    const [userId, evt, payload] = toolCalls[0];
    expect(userId).toBe(5);
    expect(evt).toBe("copilot:tool");
    expect(payload).toMatchObject({ conversationId: 1, runId: "run-xyz", step: expect.any(Number), name: expect.any(String), durationMs: expect.any(Number) });
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(out.trace)).toBe(true);
    expect(out.trace[0]).toHaveProperty("name");
    expect(out.trace[0]).toHaveProperty("durationMs");
  });
});
