import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildUnansweredUserTurnContext } from "./conversationTurnContext";

vi.mock("@config/prisma", () => ({
  default: {
    conversationMessage: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

describe("buildUnansweredUserTurnContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges consecutive unanswered user messages into one model input", async () => {
    const prisma = (await import("@config/prisma")).default as any;

    prisma.conversationMessage.findFirst
      .mockResolvedValueOnce({ id: 13 })
      .mockResolvedValueOnce({ id: 10 });
    prisma.conversationMessage.findMany.mockImplementation(async (args: any) => {
      if (args.where.role === "user") {
        return [
          { id: 11, role: "user", content: "my phone number is" },
          { id: 12, role: "user", content: "01228329423" },
          { id: 13, role: "user", content: "and my name is\nhesham" },
        ];
      }
      return [
        { id: 10, role: "model", content: "Sure, send the details." },
        { id: 9, role: "user", content: "I want to register" },
      ];
    });

    const result = await buildUnansweredUserTurnContext({
      conversationId: 5,
      latestUserMessageId: 13,
    });

    expect(result.messageText).toBe(
      "my phone number is\n01228329423\nand my name is\nhesham",
    );
    expect(result.userMessageIds).toEqual([11, 12, 13]);
    expect(result.historyTurns).toEqual([
      { role: "user", text: "I want to register" },
      { role: "model", text: "Sure, send the details." },
    ]);
  });
});
