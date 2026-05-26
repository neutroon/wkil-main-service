import { describe, expect, it, vi } from "vitest";
import { buildAgentActionTools } from "./agentActionTools";

vi.mock("@utils/logger", () => ({
  logger: {
    warn: vi.fn(),
  },
}));

describe("buildAgentActionTools", () => {
  it("does not expose active lookup actions without a required narrowing parameter", () => {
    expect(
      buildAgentActionTools([
        {
          id: 1,
          name: "all courses",
          description: "Return all available courses",
          actionType: "LOOKUP",
          expectedParamsSchema: null,
        },
      ]),
    ).toEqual([]);
  });

  it("exposes scoped lookup actions with required customer parameters", () => {
    const tools = buildAgentActionTools([
      {
        id: 2,
        name: "course by name",
        description: "Find one course by program name",
        actionType: "LOOKUP",
        expectedParamsSchema: {
          programName: {
            type: "STRING",
            source: "USER_PROVIDED",
            required: true,
            description: "Program name requested by the customer",
          },
        },
      },
    ]);

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("integration_action_2");
    expect(tools[0].schema.safeParse({ programName: "TOT" }).success).toBe(true);
    expect(tools[0].schema.safeParse({}).success).toBe(false);
  });
});
