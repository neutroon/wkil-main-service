import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("./copilot.service", () => {
  const activeRuns = new Map<string, unknown>();
  activeRuns.set("other-user", { abortController: { abort: () => {} }, conversationId: 7, userId: 999 });
  return {
    startCopilotTurn: vi.fn(async () => ({ runId: "test-run-id", conversationId: 7 })),
    cancelCopilotRun: vi.fn(async () => ({ cancelled: false })),
    activeRuns,
  };
});
vi.mock("./copilot.store", () => ({
  getOrCreateCopilotConversation: vi.fn(async () => ({ id: 7, userId: 5, kind: "GENERAL", locale: "ar", lastMessageAt: new Date() })),
  listCopilotMessages: vi.fn(async () => []),
  getCopilotConversationForUser: vi.fn(),
}));

import { startCopilotTurn } from "./copilot.service";
import { cancelCopilotRunController, getCopilotConversationController, listCopilotMessagesController, postCopilotMessageController } from "./copilot.controller";

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
    expect(startCopilotTurn).toHaveBeenCalledWith(expect.objectContaining({ userId: 5, text: "hello" }));
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({ data: expect.objectContaining({ runId: "test-run-id", conversationId: 7 }) });
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

describe("DELETE /copilot/runs/:runId", () => {
  it("returns 200 { cancelled: true } when the run is active for the user", async () => {
    const { cancelCopilotRun } = await import("./copilot.service");
    (cancelCopilotRun as any).mockResolvedValueOnce({ cancelled: true });
    const req: any = { user: { id: 5 }, params: { runId: "abc" } };
    const response = makeRes();
    await cancelCopilotRunController(req, response);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({ data: { cancelled: true } });
  });

  it("returns 404 when the run is unknown", async () => {
    const { cancelCopilotRun } = await import("./copilot.service");
    (cancelCopilotRun as any).mockResolvedValueOnce({ cancelled: false });
    const req: any = { user: { id: 5 }, params: { runId: "nope" } };
    const response = makeRes();
    await cancelCopilotRunController(req, response);
    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      error: expect.objectContaining({ message: "no active run" }),
    });
  });

  it("returns 403 when the run belongs to another user", async () => {
    const { cancelCopilotRun } = await import("./copilot.service");
    (cancelCopilotRun as any).mockResolvedValueOnce({ cancelled: false });
    const req: any = { user: { id: 5 }, params: { runId: "other-user" } };
    const response = makeRes();
    await cancelCopilotRunController(req, response);
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({
      error: expect.objectContaining({ message: "forbidden" }),
    });
  });
});
