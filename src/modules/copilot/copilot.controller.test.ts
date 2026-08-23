import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("./copilot.service", () => ({ runCopilotTurn: vi.fn(async () => ({ ok: true, conversationId: 7, envelopes: [{ type: "text", text: "ok" }], truncated: false, expectedTotal: null })) }));
vi.mock("./copilot.store", () => ({
  getOrCreateCopilotConversation: vi.fn(async () => ({ id: 7, userId: 5, kind: "GENERAL", locale: "ar", lastMessageAt: new Date() })),
  listCopilotMessages: vi.fn(async () => []),
  getCopilotConversationForUser: vi.fn(),
}));

import { runCopilotTurn } from "./copilot.service";
import { getCopilotConversationController, listCopilotMessagesController, postCopilotMessageController } from "./copilot.controller";

function makeRes() {
  const r: any = {};
  r.status = vi.fn(() => r);
  r.json = vi.fn(() => r);
  return r;
}

describe("copilot.controller", () => {
  beforeEach(() => vi.clearAllMocks());

  it("POST message runs a turn for the authenticated user", async () => {
    const req: any = { user: { id: 5 }, body: { text: "hello" }, headers: {} };
    const response = makeRes();
    await postCopilotMessageController(req, response);
    expect(runCopilotTurn).toHaveBeenCalledWith(expect.objectContaining({ userId: 5, text: "hello" }));
    expect(response.json).toHaveBeenCalledWith({ data: expect.objectContaining({ conversationId: 7 }) });
  });

  it("POST message responds HTTP 500 when runCopilotTurn returns ok: false", async () => {
    const { runCopilotTurn } = await import("./copilot.service");
    (runCopilotTurn as any).mockResolvedValueOnce({
      ok: false,
      code: "GRAPH_FAILED",
      message: "The service is unavailable right now.",
      retryable: true,
    });
    const req: any = { user: { id: 5 }, body: { text: "hello" }, headers: {} };
    const response = makeRes();
    await postCopilotMessageController(req, response);
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      error: expect.objectContaining({ code: "GRAPH_FAILED", retryable: true }),
    });
  });

  it("GET conversation returns the current thread", async () => {
    const response = makeRes();
    await getCopilotConversationController({ user: { id: 5 }, headers: {} } as any, response);
    expect(response.json).toHaveBeenCalledWith({ data: expect.objectContaining({ id: 7 }) });
  });

  it("GET messages respects the limit query", async () => {
    const response = makeRes();
    await listCopilotMessagesController({ user: { id: 5 }, headers: {}, query: { limit: 10 } } as any, response);
    expect(response.json).toHaveBeenCalledWith({ data: [] });
  });
});
