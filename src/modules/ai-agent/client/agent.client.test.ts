import { beforeEach, describe, expect, it, vi } from "vitest";

const runsCreateMock = vi.hoisted(() => vi.fn());
const threadsCreateMock = vi.hoisted(() => vi.fn(async () => ({ thread_id: "thread-1" })));

vi.mock("@langchain/langgraph-sdk", () => ({
  Client: class {
    threads = { create: threadsCreateMock };
    runs = { create: runsCreateMock };
  },
}));

import { AgentClient } from "./agent.client";

beforeEach(() => {
  runsCreateMock.mockReset();
  runsCreateMock.mockResolvedValue({});
});

describe("AgentClient", () => {
  it("is disabled when USE_AGENT_SERVICE is off", () => {
    process.env.USE_AGENT_SERVICE = "false";
    expect(AgentClient.enabled()).toBe(false);
  });
  it("enabled when flag on", () => {
    process.env.USE_AGENT_SERVICE = "true";
    expect(AgentClient.enabled()).toBe(true);
  });

  it("routes by intent: runCopilot → agent, runCustomerAgent → customer_agent", async () => {
    await AgentClient.runCopilot({ messages: [] });
    expect(runsCreateMock).toHaveBeenCalledWith(expect.any(String), "agent", expect.anything());
    await AgentClient.runCustomerAgent({ messages: [] });
    expect(runsCreateMock).toHaveBeenCalledWith(expect.any(String), "customer_agent", expect.anything());
  });

  it("exposes no generic runAgent", () => {
    expect((AgentClient as unknown as Record<string, unknown>).runAgent).toBeUndefined();
  });
});
