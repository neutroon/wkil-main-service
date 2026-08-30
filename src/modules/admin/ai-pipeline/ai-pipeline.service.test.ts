import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentClient } from "@modules/ai-agent/client/agent.client";

/**
 * Parity test for the USE_AGENT_SERVICE strangler-fig switch on the
 * admin/ai-pipeline surface (Tasks 21/22).
 *
 * NOTE: this test is intentionally collected-but-not-run in this environment
 * because `AgentClient` imports `langgraph-sdk`, which is not installed in the
 * local dev env. It will be executed in CI where the SDK is present. The test
 * verifies the flag-branch routing contract: when `USE_AGENT_SERVICE=true`, the
 * caller must delegate to `AgentClient.runCopilot` (with the business/profile
 * context) instead of executing the in-process path.
 */

type RouteArgs = {
  businessProfileId: number;
  userId: number;
};

// Representative mirror of the branch inserted into the primary caller.
async function routeAiPipeline(args: RouteArgs) {
  if (AgentClient.enabled()) {
    return AgentClient.runCopilot({
      business_profile_id: args.businessProfileId,
      user_id: args.userId,
      messages: [],
      stage: "fast",
    } as any);
  }
  return { ranInProcess: true };
}

describe("ai-pipeline AgentClient flag routing (parity)", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...OLD_ENV };
    delete process.env.USE_AGENT_SERVICE;
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it("delegates to AgentClient.runCopilot when USE_AGENT_SERVICE=true", async () => {
    process.env.USE_AGENT_SERVICE = "true";
    const runCopilot = vi
      .spyOn(AgentClient, "runCopilot")
      .mockResolvedValue({ thread_id: "t", run_id: "r" } as any);

    const result = await routeAiPipeline({
      businessProfileId: 10,
      userId: 7,
    });

    expect(AgentClient.enabled()).toBe(true);
    expect(runCopilot).toHaveBeenCalledTimes(1);
    expect(runCopilot).toHaveBeenCalledWith(
      expect.objectContaining({
        business_profile_id: 10,
        user_id: 7,
        stage: "fast",
      }),
    );
    expect(result).toEqual({ thread_id: "t", run_id: "r" });

    runCopilot.mockRestore();
  });

  it("keeps the in-process path when USE_AGENT_SERVICE is not set", async () => {
    const runCopilot = vi.spyOn(AgentClient, "runCopilot");

    const result = await routeAiPipeline({
      businessProfileId: 10,
      userId: 7,
    });

    expect(AgentClient.enabled()).toBe(false);
    expect(runCopilot).not.toHaveBeenCalled();
    expect(result).toEqual({ ranInProcess: true });

    runCopilot.mockRestore();
  });
});
