import { describe, expect, it } from "vitest";
import { AgentClient } from "./agent.client";

describe("AgentClient", () => {
  it("is disabled when USE_AGENT_SERVICE is off", () => {
    process.env.USE_AGENT_SERVICE = "false";
    expect(AgentClient.enabled()).toBe(false);
  });
  it("enabled when flag on", () => {
    process.env.USE_AGENT_SERVICE = "true";
    expect(AgentClient.enabled()).toBe(true);
  });
});
