import { describe, expect, it, vi, beforeEach } from "vitest";
import { runToolsNode } from "./runTools";
import { executeExternalQuery } from "@modules/integrations/external/externalData.service";

vi.mock("@modules/integrations/external/externalData.service", () => ({
  executeExternalQuery: vi.fn(),
}));

vi.mock("@modules/integrations/crm/crm.service", () => ({
  pushLeadToCrm: vi.fn(),
}));

vi.mock("@modules/ai-agent/chat/aiRecoveryReply", () => ({
  generateSafeRecoveryReply: vi.fn(async ({ safeFallback }) => safeFallback),
}));

const failedFallback =
  "مش قادر أتحقق من المعلومة دي حالياً بسبب مشكلة في الربط بالنظام.";

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    businessProfileId: 1,
    customerPhone: undefined,
    conversationId: 123,
    contents: [
      { role: "user", parts: [{ text: "fd" }] },
      { role: "model", parts: [{ text: "" }] },
    ],
    functionCalls: [
      {
        id: "tool_1",
        name: "query_external_api_2",
        args: { propertyName: "pagesPilot services" },
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
      },
    },
    ...overrides,
  } as any;
}

describe("runToolsNode external query guardrails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks external lookup args that were not provided by the customer", async () => {
    vi.mocked(executeExternalQuery).mockResolvedValue({
      success: false,
      verification: "failed",
      actionType: "external_query_2",
      reason: "unprovided_parameter:propertyName",
      data: null,
      error: 'External tool parameter "propertyName" was not provided by an allowed source',
    });

    const result = await runToolsNode(baseState());

    expect(executeExternalQuery).toHaveBeenCalledWith(
      1,
      2,
      { propertyName: "pagesPilot services" },
      expect.objectContaining({
        conversationId: 123,
        latestUserText: "fd",
      }),
    );
    expect(result.decision).toMatchObject({
      action: "HANDOFF_TO_HUMAN",
      handoffCategory: "MISSING_KNOWLEDGE",
      content: failedFallback,
      grounded: false,
    });
    expect(result.evidence?.failedActions).toContain("external_query_2");
  });

  it("does not execute the same failed external lookup again", async () => {
    const result = await runToolsNode(
      baseState({
        contents: [{ role: "user", parts: [{ text: "pagesPilot services" }] }],
        evidence: {
          verifiedActions: [],
          unverifiedActions: [],
          failedActions: ["external_query_2"],
          unknownActions: [],
        },
      }),
    );

    expect(executeExternalQuery).not.toHaveBeenCalled();
    expect(result.decision).toMatchObject({
      action: "HANDOFF_TO_HUMAN",
      content: failedFallback,
    });
  });
});
