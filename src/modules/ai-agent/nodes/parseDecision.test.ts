import { describe, expect, it, vi } from "vitest";
import { parseDecisionNode } from "./parseDecision";

vi.mock("@utils/logger", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
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
      { role: "user", parts: [{ text: "book the course" }] },
      {
        role: "model",
        parts: [
          {
            text: JSON.stringify({
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
      },
    ],
    ...overrides,
  }) as any;

describe("parseDecisionNode failed action safety", () => {
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
          parts: [
            expect.objectContaining({
              text: expect.stringContaining("Ask exactly one concise"),
            }),
          ],
        }),
      ]),
    );
  });
});
