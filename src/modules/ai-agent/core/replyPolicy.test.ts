import { describe, expect, it } from "vitest";
import {
  buildCompletedActionReplyPolicy,
  replyPolicyPromptBlock,
  validateDecisionAgainstReplyPolicy,
} from "./replyPolicy";

describe("reply policy", () => {
  it("turns validation failures into ask-for-correction policy", () => {
    const policy = buildCompletedActionReplyPolicy({
      handoffEnabled: true,
      envelope: {
        success: false,
        verification: "failed",
        actionType: "integration_action_2",
        reason: "action_validation_failed",
        data: {
          error: {
            details: {
              errors: [
                "Invalid phone number. Please include country code.",
              ],
            },
          },
        },
      },
    });

    expect(policy).toMatchObject({
      allowedActions: ["REPLY_AUTO"],
      allowedReplyTypes: ["ASK_FOR_CORRECTION"],
      canConfirmActionSuccess: false,
      canHandoff: false,
      requiresCustomerCorrection: true,
      failureClass: "VALIDATION_ERROR",
      correctionFields: [expect.objectContaining({ field: "phone" })],
    });
  });

  it("rejects a handoff decision when a correctable failure must ask for correction", () => {
    const policy = buildCompletedActionReplyPolicy({
      handoffEnabled: true,
      envelope: {
        success: false,
        verification: "failed",
        reason: "action_validation_failed",
        error: "Invalid phone number",
      },
    });

    expect(
      validateDecisionAgainstReplyPolicy({
        policy,
        decision: {
          action: "HANDOFF_TO_HUMAN",
          replyType: "HANDOFF",
          reasoning: "handoff",
        },
      }),
    ).toMatchObject({ ok: false });
  });

  it("tells the model to follow the provider correction detail without contradicting it", () => {
    const policy = buildCompletedActionReplyPolicy({
      handoffEnabled: true,
      envelope: {
        success: false,
        verification: "failed",
        reason: "action_validation_failed",
        error: "Invalid phone number. Please include country code.",
      },
    });

    expect(replyPolicyPromptBlock(policy!)).toContain(
      "Use customerSafeError and correctionFields as the source of truth",
    );
  });

  it("allows verified mutations to confirm success", () => {
    const policy = buildCompletedActionReplyPolicy({
      handoffEnabled: true,
      envelope: {
        success: true,
        verification: "verified",
        actionType: "MUTATION",
        reason: "provider_confirmed",
        data: { id: "lead_1" },
      },
    });

    expect(
      validateDecisionAgainstReplyPolicy({
        policy,
        decision: {
          action: "REPLY_AUTO",
          replyType: "CONFIRM_ACTION_SUCCESS",
          reasoning: "verified",
        },
      }),
    ).toEqual({ ok: true });
  });
});
