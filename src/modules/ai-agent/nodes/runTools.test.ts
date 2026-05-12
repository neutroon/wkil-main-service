import { describe, expect, it, vi, beforeEach } from "vitest";
import { runToolsNode } from "./runTools";
import { updateCustomerFromSavedDetails } from "@modules/business/customer/customer.service";
import { enqueueIntegrationAction } from "@modules/meta/core/meta.queue";
import { getExternalDataSourceStatusMetadata } from "@modules/integrations/external/externalData.service";
import { generatePendingLookupStatusDecision } from "@modules/ai-agent/chat/pendingLookupStatus";
import { validateChatRequestedExternalAction } from "@modules/ai-agent/chat/externalToolEligibility";
import {
  createIntegrationActionRun,
  markIntegrationActionRunFailed,
} from "@modules/integrations/external/integrationActionRun.service";

vi.mock("@modules/business/customer/customer.service", () => ({
  updateCustomerFromSavedDetails: vi.fn(),
}));

vi.mock("@modules/meta/core/meta.queue", () => ({
  createBullMqJobId: vi.fn((...parts: Array<string | number | null | undefined>) =>
    parts
      .filter((part) => part !== null && part !== undefined && String(part).trim().length > 0)
      .map((part) => String(part).replace(/[^a-zA-Z0-9_-]+/g, "-"))
      .join("-"),
  ),
  enqueueIntegrationAction: vi.fn(async () => undefined),
}));

vi.mock("@modules/integrations/external/externalData.service", () => ({
  getExternalDataSourceStatusMetadata: vi.fn(async () => ({
    id: 2,
    businessProfileId: 1,
    name: "Product availability",
    description: "Checks live availability.",
    trigger: "CHAT_REQUESTED",
    actionType: "LOOKUP",
    isActive: true,
    expectedParamsSchema: null,
  })),
}));

vi.mock("@modules/integrations/external/integrationActionRun.service", () => ({
  createIntegrationActionRun: vi.fn(async () => ({ id: 7001 })),
  markIntegrationActionRunFailed: vi.fn(async () => undefined),
}));

vi.mock("@modules/ai-agent/chat/pendingLookupStatus", () => ({
  generatePendingLookupStatusDecision: vi.fn(async () => ({
    action: "REPLY_AUTO",
    handoffCategory: null,
    reasoning: "Contextual status generated.",
    content: "I’m checking availability for you now.",
    privateContent: "I’m checking availability for you now.",
    publicContent: "I’m checking availability for you now.",
    requiresGrounding: false,
    grounded: true,
    usedChunkTypes: [],
    missingInfo: null,
  })),
}));

vi.mock("@modules/ai-agent/chat/externalToolEligibility", () => ({
  validateChatRequestedExternalAction: vi.fn(async () => ({
    shouldQueue: true,
    reasoning: "Action matches the latest customer message.",
  })),
}));

vi.mock("@modules/ai-agent/chat/aiRecoveryReply", () => ({
  generateSafeRecoveryReply: vi.fn(async ({ safeFallback }) => safeFallback),
}));

vi.mock("@modules/ai-agent/chat/externalToolRecoveryClassifier", () => ({
  classifyExternalToolFailureRecovery: vi.fn(async () => "handoff"),
}));

const failedFallback =
  "مش قادر أتحقق من المعلومة دي حالياً بسبب مشكلة في الربط بالنظام.";

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    businessProfileId: 1,
    businessName: "PagesPilot",
    businessVoice: "English",
    businessTone: "Friendly",
    customerPhone: undefined,
    conversationId: 123,
    contents: [
      { role: "user", parts: [{ text: "fd" }] },
      { role: "model", parts: [{ text: "" }] },
    ],
    functionCalls: [
      {
        id: "tool_1",
        name: "integration_action_2",
        args: { propertyName: "pagesPilot services" },
      },
    ],
    tools: [
      {
        functionDeclarations: [
          { name: "integration_action_2" },
        ],
      },
    ],
    evidence: {
      verifiedActions: [],
      unverifiedActions: [],
      failedActions: [],
      unknownActions: [],
    },
    policy: {
      strictBlockOnUnverified: true,
      blockPromiseLanguage: true,
      fallbackTemplates: {
        unverified: "unverified",
        failed: failedFallback,
        unsupportedPromise: "unsupported",
        smallTalkRecovery: "أهلاً بيك! تحب تعرف إيه عن خدماتنا؟",
      },
    },
    ...overrides,
  } as any;
}

describe("runToolsNode external query guardrails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats local customer detail save as verified without queueing external actions", async () => {
    vi.mocked(updateCustomerFromSavedDetails).mockResolvedValue({
      id: 44,
    } as never);

    const result = await runToolsNode(
      baseState({
        customerPhone: "+20100111222",
        tools: [
          {
            functionDeclarations: [
              { name: "save_customer_details" },
              { name: "integration_action_2" },
            ],
          },
        ],
        functionCalls: [
          {
            id: "tool_save",
            name: "save_customer_details",
            args: { name: "Mona", interest: "pricing" },
          },
        ],
      }),
    );
    await Promise.resolve();

    expect(result.tools).toEqual([
      {
        functionDeclarations: [
          { name: "integration_action_2" },
        ],
      },
    ]);
    expect(updateCustomerFromSavedDetails).toHaveBeenCalledWith({
      businessProfileId: 1,
      conversationId: 123,
      details: {
        name: "Mona",
        interest: "pricing",
      },
    });
    expect(enqueueIntegrationAction).not.toHaveBeenCalled();
    expect(result.evidence?.verifiedActions).toContain("save_customer_details");
    expect(result.evidence?.failedActions).not.toContain("save_customer_details");
    const lastTurn = result.contents?.[result.contents.length - 1];
    expect(lastTurn?.parts?.[0]).toEqual(
      expect.objectContaining({
        functionResponse: expect.objectContaining({
          name: "save_customer_details",
          response: expect.objectContaining({
            success: true,
            verification: "verified",
            reason: "customer_details_saved",
          }),
        }),
      }),
    );
  });

  it("can save customer identity from a greeting, then removes the save tool to prevent loops", async () => {
    vi.mocked(updateCustomerFromSavedDetails).mockResolvedValue({
      id: 156,
    } as never);

    const result = await runToolsNode(
      baseState({
        customerPhone: "201202840018",
        tools: [
          {
            functionDeclarations: [
              { name: "save_customer_details" },
              { name: "integration_action_2" },
            ],
          },
        ],
        contents: [
          { role: "user", parts: [{ text: "السلام عليكم" }] },
          { role: "model", parts: [{ text: "" }] },
        ],
        functionCalls: [
          {
            id: "tool_save",
            name: "save_customer_details",
            args: {
              notes: "العميل بدأ المحادثة بالتحية",
              phone: "201202840018",
            },
          },
        ],
      }),
    );

    expect(updateCustomerFromSavedDetails).toHaveBeenCalledWith({
      businessProfileId: 1,
      conversationId: 123,
      details: {
        notes: "العميل بدأ المحادثة بالتحية",
        phone: "201202840018",
      },
    });
    expect(result.tools).toEqual([
      {
        functionDeclarations: [
          { name: "integration_action_2" },
        ],
      },
    ]);
    expect(result.evidence?.verifiedActions).toContain("save_customer_details");
    const lastTurn = result.contents?.[result.contents.length - 1];
    expect(lastTurn?.parts?.[0]).toEqual(
      expect.objectContaining({
        functionResponse: expect.objectContaining({
          name: "save_customer_details",
          response: expect.objectContaining({
            verification: "verified",
            reason: "customer_details_saved",
            data: { customerId: 156 },
          }),
        }),
      }),
    );
  });

  it("does not execute repeated customer-detail saves in the same graph turn", async () => {
    const result = await runToolsNode(
      baseState({
        tools: [
          {
            functionDeclarations: [
              { name: "save_customer_details" },
              { name: "integration_action_2" },
            ],
          },
        ],
        evidence: {
          verifiedActions: ["save_customer_details"],
          unverifiedActions: [],
          failedActions: [],
          unknownActions: [],
        },
        functionCalls: [
          {
            id: "tool_save_again",
            name: "save_customer_details",
            args: { name: "Mona" },
          },
        ],
      }),
    );

    expect(updateCustomerFromSavedDetails).not.toHaveBeenCalled();
    expect(result.tools).toEqual([
      {
        functionDeclarations: [
          { name: "integration_action_2" },
        ],
      },
    ]);
    const lastTurn = result.contents?.[result.contents.length - 1];
    expect(lastTurn?.parts?.[0]).toEqual(
      expect.objectContaining({
        functionResponse: expect.objectContaining({
          name: "save_customer_details",
          response: expect.objectContaining({
            verification: "not_applicable",
            reason: "customer_details_already_saved_this_turn",
            data: { saved: false },
          }),
        }),
      }),
    );
  });

  it("queues integration actions and returns deterministic status content", async () => {
    const result = await runToolsNode(baseState());

    expect(enqueueIntegrationAction).toHaveBeenCalledWith(
      expect.objectContaining({
        businessProfileId: 1,
        trigger: "CHAT_REQUESTED",
        conversationId: 123,
        sourceId: 2,
        actionRunId: 7001,
        toolName: "integration_action_2",
        args: { propertyName: "pagesPilot services" },
        latestUserText: "fd",
      }),
      expect.objectContaining({
        jobId: expect.stringContaining("integration-action-CHAT_REQUESTED-123-"),
      }),
    );
    expect(createIntegrationActionRun).toHaveBeenCalledWith(
      expect.objectContaining({
        businessProfileId: 1,
        sourceId: 2,
        conversationId: 123,
        trigger: "CHAT_REQUESTED",
        toolName: "integration_action_2",
        jobId: expect.stringContaining("integration-action-CHAT_REQUESTED-123-"),
      }),
    );
    expect(generatePendingLookupStatusDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        businessName: "PagesPilot",
        voice: "English",
        tone: "Friendly",
        channel: undefined,
        latestUserText: "fd",
        recentTurns: [
          { role: "user", text: "fd" },
        ],
        source: expect.objectContaining({
          name: "Product availability",
        }),
      }),
    );
    expect(result.decision).toMatchObject({
      action: "REPLY_AUTO",
      content: "I’m checking availability for you now.",
      requiresGrounding: false,
    });
    expect(result.evidence?.verifiedActions).toContain("integration_action_2");
    const lastTurn = result.contents?.[result.contents.length - 1];
    const response = (lastTurn as any)?.parts?.[0]?.functionResponse?.response;
    expect(response.data).toMatchObject({
      queued: true,
      sourceId: 2,
      actionRunId: 7001,
    });
  });

  it("blocks integration actions for pure greetings even when the model calls one", async () => {
    vi.mocked(validateChatRequestedExternalAction).mockResolvedValueOnce({
      shouldQueue: false,
      reasoning: "The latest customer message is only a greeting.",
    });

    const result = await runToolsNode(
      baseState({
        contents: [{ role: "user", parts: [{ text: "اهلا" }] }],
      }),
    );

    expect(createIntegrationActionRun).not.toHaveBeenCalled();
    expect(enqueueIntegrationAction).not.toHaveBeenCalled();
    expect(generatePendingLookupStatusDecision).not.toHaveBeenCalled();
    expect(result.decision).toBeUndefined();
    const lastTurn = result.contents?.[result.contents.length - 1];
    const response = (lastTurn as any)?.parts?.[0]?.functionResponse?.response;
    expect(response).toMatchObject({
      verification: "not_applicable",
      reason: "action_policy_rejected",
      data: {
        queued: false,
        policyReason: "The latest customer message is only a greeting.",
      },
    });
  });

  it("blocks hallucinated integration actions that were not exposed for the turn", async () => {
    const result = await runToolsNode(
      baseState({
        tools: undefined,
        contents: [{ role: "user", parts: [{ text: "what is the price?" }] }],
      }),
    );

    expect(getExternalDataSourceStatusMetadata).not.toHaveBeenCalled();
    expect(createIntegrationActionRun).not.toHaveBeenCalled();
    expect(enqueueIntegrationAction).not.toHaveBeenCalled();
    expect(result.decision).toMatchObject({
      action: "HANDOFF_TO_HUMAN",
      content: failedFallback,
    });
    expect(result.evidence?.failedActions).toContain("integration_action_2");
  });

  it("does not execute the same failed external lookup again", async () => {
    const result = await runToolsNode(
      baseState({
        contents: [{ role: "user", parts: [{ text: "pagesPilot services" }] }],
        evidence: {
          verifiedActions: [],
          unverifiedActions: [],
          failedActions: ["integration_action_2"],
          unknownActions: [],
        },
      }),
    );

    expect(enqueueIntegrationAction).not.toHaveBeenCalled();
    expect(result.decision).toMatchObject({
      action: "HANDOFF_TO_HUMAN",
      content: failedFallback,
    });
  });

  it("does not block queueing if AI status generation returns no text", async () => {
    vi.mocked(generatePendingLookupStatusDecision).mockResolvedValueOnce(null as any);

    const result = await runToolsNode(
      baseState({
        contents: [{ role: "user", parts: [{ text: "pagesPilot services" }] }],
      }),
    );

    expect(enqueueIntegrationAction).toHaveBeenCalled();
    expect(result.decision).toMatchObject({
      action: "REPLY_AUTO",
      content: "",
      requiresGrounding: false,
    });
    expect(result.evidence?.verifiedActions).toContain("integration_action_2");
  });

  it("routes to failure recovery if the integration action cannot be queued", async () => {
    vi.mocked(enqueueIntegrationAction).mockRejectedValueOnce(new Error("redis down"));

    const result = await runToolsNode(baseState());

    expect(result.decision).toMatchObject({ action: "HANDOFF_TO_HUMAN" });
    expect(result.evidence?.failedActions).toContain("integration_action_2");
    expect(markIntegrationActionRunFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 7001,
        reason: "redis down",
      }),
    );
    expect(generatePendingLookupStatusDecision).not.toHaveBeenCalled();
  });
});
