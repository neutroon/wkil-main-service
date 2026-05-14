import { describe, expect, it } from "vitest";
import { windowContents } from "./contextWindow";
import type { GeminiContent } from "./agentState";

describe("windowContents", () => {
  it("keeps the user turn before a retained function call and function response", () => {
    const history: GeminiContent[] = [
      { role: "model", parts: [{ text: "old ".repeat(1000) }] },
      { role: "user", parts: [{ text: "السلام عليكم" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: {
              name: "integration_action_2",
              args: { name: "Ahmed" },
            },
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "integration_action_2",
              response: { success: true },
            },
          },
        ],
      },
    ];

    const result = windowContents(history, 10_000);

    expect(result).toEqual(history.slice(1));
  });

  it("keeps chained function exchanges valid when the budget is exhausted", () => {
    const history: GeminiContent[] = [
      { role: "user", parts: [{ text: "احجز برنامج الدعم النفسي بالفنون" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: {
              name: "integration_action_1",
              args: { query: "الدعم النفسي بالفنون" },
            },
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "integration_action_1",
              response: { success: true },
            },
          },
        ],
      },
      {
        role: "model",
        parts: [
          {
            functionCall: {
              name: "integration_action_2",
              args: { courseId: "course-123" },
            },
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "integration_action_2",
              response: { queued: false },
            },
          },
        ],
      },
    ];

    const result = windowContents(history, 10_000);

    expect(result).toEqual(history);
  });
});
