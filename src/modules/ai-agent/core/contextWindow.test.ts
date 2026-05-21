import { describe, expect, it } from "vitest";
import { windowContents } from "./contextWindow";
import type { AgentContent } from "./agentState";

describe("windowContents", () => {
  it("keeps the user turn before a retained function call and function response", () => {
    const history: AgentContent[] = [
      { role: "model", content: "old ".repeat(1000) },
      { role: "user", content: "السلام عليكم" },
      {
        role: "model",
        toolCalls: [
          {
            name: "integration_action_2",
            args: { name: "Ahmed" },
          },
        ],
      },
      {
        role: "tool",
        toolName: "integration_action_2",
        toolResult: { success: true },
      },
    ];

    const result = windowContents(history, 10_000);

    expect(result).toEqual(history.slice(1));
  });

  it("keeps chained function exchanges valid when the budget is exhausted", () => {
    const history: AgentContent[] = [
      { role: "user", content: "احجز برنامج الدعم النفسي بالفنون" },
      {
        role: "model",
        toolCalls: [
          {
            name: "integration_action_1",
            args: { query: "الدعم النفسي بالفنون" },
          },
        ],
      },
      {
        role: "tool",
        toolName: "integration_action_1",
        toolResult: { success: true },
      },
      {
        role: "model",
        toolCalls: [
          {
            name: "integration_action_2",
            args: { courseId: "course-123" },
          },
        ],
      },
      {
        role: "tool",
        toolName: "integration_action_2",
        toolResult: { queued: false },
      },
    ];

    const result = windowContents(history, 10_000);

    expect(result).toEqual(history);
  });
});
