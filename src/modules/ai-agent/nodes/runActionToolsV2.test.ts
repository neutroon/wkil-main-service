import { beforeEach, describe, expect, it, vi } from "vitest";
import { runActionToolsV2Node } from "./runActionToolsV2";

vi.mock("@modules/meta/core/meta.queue", () => ({
  createBullMqJobId: vi.fn((...parts: unknown[]) => parts.join("-")),
  enqueueIntegrationAction: vi.fn(async () => undefined),
}));

vi.mock("@modules/integrations/external/agentActionExecutor.service", () => ({
  getAgentActionSourceStatusMetadata: vi.fn(async () => ({
    id: 2,
    businessProfileId: 1,
    name: "capture lead",
    description: "Capture a lead",
    trigger: "CHAT_REQUESTED",
    actionType: "MUTATION",
    isActive: true,
    expectedParamsSchema: null,
  })),
}));

vi.mock("@modules/integrations/external/integrationActionRun.service", () => ({
  createIntegrationActionRun: vi.fn(async () => ({ id: 42 })),
  markIntegrationActionRunFailed: vi.fn(async () => undefined),
}));

vi.mock("@modules/ai-agent/chat/externalToolEligibility", () => ({
  validateChatRequestedExternalAction: vi.fn(async () => ({
    shouldQueue: true,
    reasoning: "ok",
  })),
}));

vi.mock("@modules/ai-agent/chat/pendingLookupStatus", () => ({
  generatePendingLookupStatusDecision: vi.fn(async () => ({
    action: "REPLY_AUTO",
    reasoning: "queued",
    content: "I will check that and get back to you.",
    requiresGrounding: false,
    grounded: false,
    usedChunkTypes: [],
  })),
}));

vi.mock("@modules/ai-agent/core/agentTurn.service", () => ({
  updateAgentTurnStatus: vi.fn(async () => undefined),
}));

vi.mock("./recoveryDecision", () => ({
  buildAiRecoveryDecision: vi.fn(async (_state, params) => ({
    action: params.action,
    handoffCategory: params.handoffCategory,
    reasoning: params.reasoning,
    content: "I need one more detail before I can do that.",
    requiresGrounding: params.requiresGrounding,
    grounded: false,
    usedChunkTypes: [],
    missingInfo: params.missingInfo,
    agentTurnStatus: "COMPLETED",
  })),
}));

const baseState = () =>
  ({
    businessProfileId: 1,
    businessName: "PagesPilot",
    conversationId: 123,
    agentTurnId: 555,
    activeWorkflowId: 9,
    parentActionRunId: 41,
    actionStepKey: "mutation",
    customerPhone: "+201234567890",
    channel: "messenger",
    functionCalls: [
      {
        id: "call_1",
        name: "integration_action_2",
        args: { name: "Hesham" },
      },
    ],
    contents: [
      { role: "user", parts: [{ text: "عاوز احجز" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "integration_action_2", args: {} } }],
      },
    ],
  }) as any;

describe("runActionToolsV2Node", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queues exactly one correlated background action and ends the graph turn", async () => {
    const { enqueueIntegrationAction } = await import("@modules/meta/core/meta.queue");
    const { createIntegrationActionRun } = await import(
      "@modules/integrations/external/integrationActionRun.service"
    );

    const result = await runActionToolsV2Node(baseState());

    expect(createIntegrationActionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 123,
        agentTurnId: 555,
        parentRunId: 41,
        workflowId: 9,
        stepKey: "mutation",
        sourceId: 2,
        requestPayload: { name: "Hesham" },
      }),
    );
    expect(enqueueIntegrationAction).toHaveBeenCalledWith(
      expect.objectContaining({
        agentTurnId: 555,
        parentRunId: 41,
        workflowId: 9,
        stepKey: "mutation",
        sourceId: 2,
        actionRunId: 42,
      }),
      { jobId: "integration-action-555-2-mutation" },
    );
    expect(result.hadToolExecution).toBe(true);
    expect(result.decision).toMatchObject({
      action: "REPLY_AUTO",
      queuedActionRunId: 42,
      queuedActionSourceId: 2,
      agentTurnStatus: "WAITING_ACTION",
    });
  });

  it("does not enqueue when deterministic validation rejects the action", async () => {
    const { enqueueIntegrationAction } = await import("@modules/meta/core/meta.queue");
    const { validateChatRequestedExternalAction } = await import(
      "@modules/ai-agent/chat/externalToolEligibility"
    );
    vi.mocked(validateChatRequestedExternalAction).mockResolvedValueOnce({
      shouldQueue: false,
      reasoning: "unprovided_parameter:name",
    });

    const result = await runActionToolsV2Node(baseState());

    expect(enqueueIntegrationAction).not.toHaveBeenCalled();
    expect(result.decision).toMatchObject({
      action: "REPLY_AUTO",
      missingInfo: "unprovided_parameter:name",
      agentTurnStatus: "COMPLETED",
    });
  });
});
