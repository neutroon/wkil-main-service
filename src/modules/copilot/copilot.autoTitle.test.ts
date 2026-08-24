import { beforeEach, describe, expect, it, vi } from "vitest";

const { listCopilotMessagesMock, updateConversationTitleMock, loggerMock } = vi.hoisted(() => ({
  listCopilotMessagesMock: vi.fn(),
  updateConversationTitleMock: vi.fn(),
  loggerMock: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@utils/logger", () => ({ logger: loggerMock }));
vi.mock("./copilot.store", () => ({
  listCopilotMessages: listCopilotMessagesMock,
  updateConversationTitle: updateConversationTitleMock,
}));

import { maybeAutoTitle } from "./copilot.autoTitle";

describe("maybeAutoTitle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when the conversation already has a title", async () => {
    maybeAutoTitle(7, 5, "Existing");
    await new Promise((r) => setTimeout(r, 10));
    expect(listCopilotMessagesMock).not.toHaveBeenCalled();
    expect(updateConversationTitleMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it("sets the title from the first user message when title is null", async () => {
    listCopilotMessagesMock.mockResolvedValueOnce([
      { id: 1, role: "USER", envelope: { type: "text", text: "hello world" } },
    ]);
    maybeAutoTitle(7, 5, null);
    await new Promise((r) => setTimeout(r, 10));
    expect(updateConversationTitleMock).toHaveBeenCalledWith(7, 5, "hello world");
  });

  it("truncates titles longer than 50 chars with an ellipsis", async () => {
    const long = "a".repeat(60);
    listCopilotMessagesMock.mockResolvedValueOnce([
      { id: 1, role: "USER", envelope: { type: "text", text: long } },
    ]);
    maybeAutoTitle(7, 5, undefined);
    await new Promise((r) => setTimeout(r, 10));
    expect(updateConversationTitleMock).toHaveBeenCalledWith(7, 5, `${"a".repeat(50)}…`);
  });

  it("does not call updateConversationTitle when there is no user message", async () => {
    listCopilotMessagesMock.mockResolvedValueOnce([
      { id: 1, role: "ASSISTANT", envelope: { type: "text", text: "hi" } },
    ]);
    maybeAutoTitle(7, 5, null);
    await new Promise((r) => setTimeout(r, 10));
    expect(updateConversationTitleMock).not.toHaveBeenCalled();
  });

  it("logs a warning instead of swallowing the error when listCopilotMessages throws", async () => {
    listCopilotMessagesMock.mockRejectedValueOnce(new Error("DB down"));
    maybeAutoTitle(7, 5, null);
    await new Promise((r) => setTimeout(r, 10));
    expect(updateConversationTitleMock).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    const [message, ctx] = loggerMock.warn.mock.calls[0];
    expect(message).toMatch(/auto.?title/i);
    expect(ctx).toMatchObject({ conversationId: 7, userId: 5 });
  });

  it("logs a warning when updateConversationTitle throws", async () => {
    listCopilotMessagesMock.mockResolvedValueOnce([
      { id: 1, role: "USER", envelope: { type: "text", text: "hi" } },
    ]);
    updateConversationTitleMock.mockRejectedValueOnce(new Error("update failed"));
    maybeAutoTitle(7, 5, null);
    await new Promise((r) => setTimeout(r, 10));
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });
});
