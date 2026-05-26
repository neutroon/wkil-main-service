import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseDecisionNode } from "./parseDecision";
import { repairStructuredDecisionOutput } from "./structuredOutputRepair";

vi.mock("@utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("./structuredOutputRepair", () => ({
  repairStructuredDecisionOutput: vi.fn(),
}));

const baseState = (overrides: Record<string, unknown> = {}) =>
  ({
    businessProfileId: 1,
    channel: "messenger",
    turnCount: 1,
    availableChunkTypes: [],
    contextQuality: "specific_evidence_found",
    handoffEnabled: true,
    policy: {
      fallbackTemplates: {
        unverified: "Please send the corrected detail.",
        failed: "Please wait for a human.",
      },
    },
    contents: [
      { role: "user", content: "book the course" },
      {
        role: "model",
        content: JSON.stringify({
          action: "HANDOFF_TO_HUMAN",
          replyType: "HANDOFF",
          reasoning: "The CRM failed, so route to staff.",
          content: "A specialist will contact you.",
          requiresGrounding: false,
          grounded: false,
          usedChunkTypes: [],
          handoffCategory: "SALES_OPPORTUNITY",
          missingInfo: null,
        }),
      },
    ],
    ...overrides,
  }) as any;

describe("parseDecisionNode failed action safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks unsafe confirmation or handoff after a correctable failed action", async () => {
    const result = await parseDecisionNode(
      baseState({
        replyPolicy: {
          active: true,
          reason: "correctable_action_failure",
          allowedActions: ["REPLY_AUTO"],
          allowedReplyTypes: ["ASK_FOR_CORRECTION"],
          canConfirmActionSuccess: false,
          canHandoff: false,
          requiresCustomerCorrection: true,
          failureClass: "VALIDATION_ERROR",
          customerSafeError: "Invalid phone number. Please include country code.",
          correctionFields: [{ field: "phone", reason: "COUNTRY_CODE_REQUIRED" }],
        },
      }),
    );

    expect(result.decision).toBeNull();
    expect(result.contents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: expect.stringContaining("Ask exactly one concise"),
        }),
      ]),
    );
  });

  it("uses one structured-output repair attempt before customer recovery", async () => {
    vi.mocked(repairStructuredDecisionOutput).mockResolvedValueOnce({
      decision: {
        action: "REPLY_AUTO",
        replyType: "NORMAL_REPLY",
        reasoning: "Recovered schema-valid routing decision.",
        content: "أهلاً بحضرتك، أقدر أساعدك؟",
        requiresGrounding: false,
        grounded: false,
        usedChunkTypes: [],
        missingInfo: null,
        attachment: null,
      },
      sessionStats: {
        promptTokens: 100,
        completionTokens: 20,
        groundingCalls: 0,
        lastBilledPromptTokens: 0,
        lastBilledCompletionTokens: 0,
        lastBilledGrounding: 0,
        modelName: "gemini-3-flash-preview",
      },
    });

    const result = await parseDecisionNode(
      baseState({
        contents: [
          { role: "user", content: "اهلا" },
          {
            role: "model",
            content: JSON.stringify({
              action: "REPLY_AUTO",
              reasoning: "Missing replyType should fail strict parsing.",
              content: "أهلاً بحضرتك، أقدر أساعدك؟",
              requiresGrounding: false,
              grounded: false,
              usedChunkTypes: [],
            }),
          },
        ],
      }),
    );

    expect(repairStructuredDecisionOutput).toHaveBeenCalledTimes(1);
    expect(result.decision).toMatchObject({
      action: "REPLY_AUTO",
      replyType: "NORMAL_REPLY",
      content: "أهلاً بحضرتك، أقدر أساعدك؟",
    });
    expect(result.sessionStats).toMatchObject({
      promptTokens: 100,
      completionTokens: 20,
    });
  });

  it("normalizes KNOWLEDGE chunk claims to custom_section evidence", async () => {
    const result = await parseDecisionNode(
      baseState({
        availableChunkTypes: ["identity", "custom_section", "faq"],
        contents: [
          { role: "user", content: "ازاي اسجل؟" },
          {
            role: "model",
            content: JSON.stringify({
              action: "REPLY_AUTO",
              replyType: "NORMAL_REPLY",
              reasoning: "الرد مبني على طرق التقديم المتاحة.",
              content: "تقدر تسيب اسمك ورقمك واسم البرنامج هنا.",
              requiresGrounding: true,
              grounded: true,
              usedChunkTypes: ["KNOWLEDGE"],
              missingInfo: null,
            }),
          },
        ],
      }),
    );

    expect(result.decision).toMatchObject({
      action: "REPLY_AUTO",
      usedChunkTypes: ["custom_section"],
    });
  });

  it("adds a default handoff category when the model chooses handoff without one", async () => {
    const result = await parseDecisionNode(
      baseState({
        contents: [
          { role: "user", content: "محتاج حد يتابع معايا" },
          {
            role: "model",
            content: JSON.stringify({
              action: "HANDOFF_TO_HUMAN",
              replyType: "HANDOFF",
              reasoning: "العميل يحتاج متابعة بشرية.",
              content: "تمام، هحوّل طلب حضرتك لفريقنا للمتابعة.",
              requiresGrounding: false,
              grounded: false,
              usedChunkTypes: [],
              missingInfo: null,
            }),
          },
        ],
      }),
    );

    expect(result.decision).toMatchObject({
      action: "HANDOFF_TO_HUMAN",
      handoffCategory: "GENERAL_HANDOFF",
    });
  });
});
