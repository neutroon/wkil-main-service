import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@middlewares/errorHandler.middleware";

vi.mock("@utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("./copilot.service", () => {
  const activeRuns = new Map<string, unknown>();
  activeRuns.set("other-user", { abortController: { abort: () => {} }, conversationId: 7, userId: 999 });
  return {
    startCopilotTurn: vi.fn(async () => ({ runId: "test-run-id", conversationId: 7 })),
    cancelCopilotRun: vi.fn(async () => ({ cancelled: false })),
    startCopilotRegenerate: vi.fn(),
    activeRuns,
  };
});
vi.mock("./copilot.store", () => ({
  getOrCreateCopilotConversation: vi.fn(async () => ({ id: 7, userId: 5, kind: "GENERAL", locale: "ar", lastMessageAt: new Date() })),
  listCopilotMessages: vi.fn(async () => []),
  getCopilotConversationForUser: vi.fn(),
  listConversationsForUser: vi.fn(),
  createConversation: vi.fn(),
  updateConversationTitle: vi.fn(),
  deleteConversation: vi.fn(),
}));

import { startCopilotTurn } from "./copilot.service";
import {
  cancelCopilotRunController,
  createConversationController,
  detectLocale,
  deleteConversationController,
  getCopilotConversationController,
  listConversationsController,
  listCopilotMessagesController,
  postCopilotMessageController,
  regenerateCopilotMessageController,
  updateConversationTitleController,
} from "./copilot.controller";

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

  it("POST message forwards a body conversationId to startCopilotTurn", async () => {
    // Regression: previously the controller only destructured `text` from the
    // body, so the frontend's `conversationId` was silently dropped and
    // `startCopilotTurn` always fell through to `getOrCreateCopilotConversation`
    // (the most-recent existing thread). Sending a message in a "New chat"
    // then silently landed in the previous conversation.
    const req: any = { user: { id: 5 }, body: { text: "hello", conversationId: 99 }, headers: {} };
    const response = makeRes();
    await postCopilotMessageController(req, response);
    expect(startCopilotTurn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 5, text: "hello", conversationId: 99 }),
    );
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
      data: { cancelled: false, message: "no active run" },
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
      data: { cancelled: false, message: "forbidden" },
    });
  });
});

describe("regenerateCopilotMessageController", () => {
  it("POST regenerate returns 200 with runId + conversationId", async () => {
    const { startCopilotRegenerate } = await import("./copilot.service");
    (startCopilotRegenerate as any).mockResolvedValueOnce({
      runId: "regen-123",
      conversationId: 7,
    });
    const req: any = { user: { id: 5 }, params: { userMsgId: 41 }, headers: {} };
    const response = makeRes();
    await regenerateCopilotMessageController(req, response);
    expect(startCopilotRegenerate).toHaveBeenCalledWith(expect.objectContaining({ userId: 5, userMsgId: 41 }));
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      data: { runId: "regen-123", conversationId: 7 },
    });
  });

  it("POST regenerate returns 404 when startCopilotRegenerate throws 404", async () => {
    const { startCopilotRegenerate } = await import("./copilot.service");
    (startCopilotRegenerate as any).mockRejectedValueOnce(new AppError("parent message not found", 404, false));
    const req: any = { user: { id: 5 }, params: { userMsgId: 99 }, headers: {} };
    const response = makeRes();
    await regenerateCopilotMessageController(req, response);
    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      error: expect.objectContaining({ message: "parent message not found" }),
    });
  });

  it("POST regenerate returns 422 when startCopilotRegenerate throws 422", async () => {
    const { startCopilotRegenerate } = await import("./copilot.service");
    (startCopilotRegenerate as any).mockRejectedValueOnce(new AppError("no assistant response to regenerate", 422, false));
    const req: any = { user: { id: 5 }, params: { userMsgId: 41 }, headers: {} };
    const response = makeRes();
    await regenerateCopilotMessageController(req, response);
    expect(response.status).toHaveBeenCalledWith(422);
  });
});

describe("listConversationsController", () => {
  it("returns 200 with the user's conversations", async () => {
    const { listConversationsForUser } = await import("./copilot.store");
    (listConversationsForUser as any).mockResolvedValueOnce([
      { id: 1, userId: 5, kind: "GENERAL", locale: "ar", title: "Chat 1", lastMessageAt: new Date() },
      { id: 2, userId: 5, kind: "GENERAL", locale: "ar", title: null, lastMessageAt: new Date() },
    ]);
    const req: any = { user: { id: 5 }, headers: {} };
    const response = makeRes();
    await listConversationsController(req, response);
    expect(listConversationsForUser).toHaveBeenCalledWith(5);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ id: 1, title: "Chat 1" }),
        expect.objectContaining({ id: 2, title: null }),
      ]),
    });
  });
});

describe("createConversationController", () => {
  it("returns 200 with { id, conversationId } on success", async () => {
    const { createConversation } = await import("./copilot.store");
    (createConversation as any).mockResolvedValueOnce({
      id: 42, userId: 5, kind: "GENERAL", locale: "en", title: null, lastMessageAt: new Date(),
    });
    const req: any = { user: { id: 5 }, headers: {} };
    const response = makeRes();
    await createConversationController(req, response);
    expect(createConversation).toHaveBeenCalledWith(5, "en");
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith({ data: { id: 42, conversationId: 42 } });
  });
});

describe("updateConversationTitleController", () => {
  it("returns 200 on successful rename", async () => {
    const { updateConversationTitle } = await import("./copilot.store");
    (updateConversationTitle as any).mockResolvedValueOnce(undefined);
    const req: any = { user: { id: 5 }, params: { id: "42" }, body: { title: "New name" }, headers: {} };
    const response = makeRes();
    await updateConversationTitleController(req, response);
    expect(updateConversationTitle).toHaveBeenCalledWith(42, 5, "New name");
    expect(response.status).toHaveBeenCalledWith(200);
  });

  it("returns 404 when conversation not found", async () => {
    const { updateConversationTitle } = await import("./copilot.store");
    (updateConversationTitle as any).mockRejectedValueOnce(new AppError("conversation not found", 404, false));
    const req: any = { user: { id: 5 }, params: { id: "99" }, body: { title: "x" }, headers: {} };
    const response = makeRes();
    await updateConversationTitleController(req, response);
    expect(response.status).toHaveBeenCalledWith(404);
  });
});

describe("deleteConversationController", () => {
  it("returns 204 on successful delete", async () => {
    const { deleteConversation } = await import("./copilot.store");
    (deleteConversation as any).mockResolvedValueOnce(undefined);
    const req: any = { user: { id: 5 }, params: { id: "42" }, headers: {} };
    const response = makeRes();
    await deleteConversationController(req, response);
    expect(deleteConversation).toHaveBeenCalledWith(42, 5);
    expect(response.status).toHaveBeenCalledWith(204);
  });

  it("returns 404 when conversation not found", async () => {
    const { deleteConversation } = await import("./copilot.store");
    (deleteConversation as any).mockRejectedValueOnce(new AppError("conversation not found", 404, false));
    const req: any = { user: { id: 5 }, params: { id: "99" }, headers: {} };
    const response = makeRes();
    await deleteConversationController(req, response);
    expect(response.status).toHaveBeenCalledWith(404);
  });
});

describe("detectLocale", () => {
  it("prefers X-Locale 'ar' over an English Accept-Language", () => {
    const req: any = {
      headers: { "x-locale": "ar", "accept-language": "en-US,en;q=0.9" },
    };
    expect(detectLocale(req)).toBe("ar");
  });

  it("prefers X-Locale 'en' over an Arabic Accept-Language", () => {
    const req: any = {
      headers: { "x-locale": "en", "accept-language": "ar-EG,ar;q=0.9" },
    };
    expect(detectLocale(req)).toBe("en");
  });

  it("falls back to Accept-Language when X-Locale is missing", () => {
    const req: any = { headers: { "accept-language": "ar-EG,ar;q=0.9" } };
    expect(detectLocale(req)).toBe("ar");
  });

  it("returns en when neither header is present", () => {
    const req: any = { headers: {} };
    expect(detectLocale(req)).toBe("en");
  });

  it("ignores garbage X-Locale values and falls back to Accept-Language", () => {
    const req: any = {
      headers: { "x-locale": "fr-FR", "accept-language": "ar" },
    };
    expect(detectLocale(req)).toBe("ar");
  });

  it("normalizes whitespace and casing in X-Locale", () => {
    const req: any = { headers: { "x-locale": "  AR  " } };
    expect(detectLocale(req)).toBe("ar");
  });
});
