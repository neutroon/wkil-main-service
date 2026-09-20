import { describe, expect, it } from "vitest";
import {
  CUSTOMER_AGENT_CONTINUATION_LIMITS,
  customerAgentContinuationSchema,
  customerAgentDecisionSchema,
  projectCustomerAgentContinuation,
} from "./customerAgent.types";

describe("customerAgentDecisionSchema", () => {
  it("accepts a reply and rejects content on NO_REPLY", () => {
    expect(
      customerAgentDecisionSchema.parse({
        action: "REPLY",
        content: "We are open at 9.",
        reason_code: "KNOWLEDGE_MATCH",
        handoff_category: null,
      }).action,
    ).toBe("REPLY");

    expect(() =>
      customerAgentDecisionSchema.parse({
        action: "NO_REPLY",
        content: "must not send",
        reason_code: "POLICY_SUPPRESSED",
      }),
    ).toThrow();
  });

  it("preserves a validated attachment request in a reply decision", () => {
    expect(customerAgentDecisionSchema.parse({
      action: "REPLY",
      content: "Here is the brochure.",
      reason_code: "KNOWLEDGE_MATCH",
      handoff_category: null,
      attachment: { asset_name: "brochure", caption: "Product details" },
    })).toMatchObject({
      attachment: { asset_name: "brochure", caption: "Product details" },
    });
  });
});

describe("customerAgentContinuationSchema", () => {
  const envelope = {
    success: true,
    verification: "verified" as const,
    actionType: "integration_action_22",
    reason: "data_returned",
    data: { available: true },
  };

  it.each([
    { success: true, verification: "failed" },
    { success: false, verification: "verified" },
  ])("rejects semantically inconsistent success/verification: %o", (values) => {
    expect(() => customerAgentContinuationSchema.parse({
      type: "external_action_result",
      envelope: { ...envelope, ...values },
    })).toThrow();
  });

  it("rejects an error attached to a successful envelope", () => {
    expect(() => customerAgentContinuationSchema.parse({
      type: "external_action_result",
      envelope: { ...envelope, error: "should not be present" },
    })).toThrow();
  });

  it("requires the same envelope key set as the Python boundary", () => {
    const missingData = { ...envelope } as Record<string, unknown>;
    delete missingData.data;
    expect(() => projectCustomerAgentContinuation({
      type: "external_action_result",
      envelope: missingData,
    })).toThrow();

    expect(() => projectCustomerAgentContinuation({
      type: "external_action_result",
      envelope: { ...envelope, unexpected: true },
    })).toThrow();
  });

  it("rejects blank optional errors", () => {
    expect(() => projectCustomerAgentContinuation({
      type: "external_action_result",
      envelope: { ...envelope, error: "   " },
    })).toThrow();
  });

  it("rejects malformed nullable errors and lone-surrogate Unicode", () => {
    expect(() => projectCustomerAgentContinuation({
      type: "external_action_result",
      envelope: { ...envelope, error: null },
    })).toThrow();

    expect(() => projectCustomerAgentContinuation({
      type: "external_action_result",
      envelope: { ...envelope, data: "\ud800" },
    })).toThrow(/Unicode|surrogate/i);
  });

  it("keeps nested data deterministic and within depth, key, and item limits", () => {
    const data = Object.fromEntries([
      ...Array.from({ length: 40 }, (_, index) => [`key-${index}`, index]),
      ["items", Array.from({ length: 40 }, (_, index) => index)],
      ["deep", { one: { two: { three: { four: { five: { six: "hidden" } } } } } }],
      ["a-negativeZero", -0],
    ]);
    const projected = projectCustomerAgentContinuation({
      type: "external_action_result",
      envelope: { ...envelope, data },
    });
    const projectedData = projected.envelope.data as Record<string, unknown>;
    const projectedItems = projectedData.items as unknown[];

    expect(Object.keys(projectedData).length)
      .toBeLessThanOrEqual(CUSTOMER_AGENT_CONTINUATION_LIMITS.maxObjectKeys);
    expect(projectedData[CUSTOMER_AGENT_CONTINUATION_LIMITS.truncationKey])
      .toBe(CUSTOMER_AGENT_CONTINUATION_LIMITS.truncationMarker);
    expect(projectedItems.length)
      .toBeLessThanOrEqual(CUSTOMER_AGENT_CONTINUATION_LIMITS.maxArrayItems);
    expect(projectedItems.at(-1)).toBe(CUSTOMER_AGENT_CONTINUATION_LIMITS.truncationMarker);
    expect(JSON.stringify(projectedData.deep)).toContain(CUSTOMER_AGENT_CONTINUATION_LIMITS.truncationMarker);
    expect(Object.is(projectedData["a-negativeZero"], 0)).toBe(true);
  });

  it("does not overwrite values when truncated keys collide", () => {
    const keyA = `${"x".repeat(200)}a`;
    const keyB = `${"x".repeat(200)}b`;
    const projected = projectCustomerAgentContinuation({
      type: "external_action_result",
      envelope: { ...envelope, data: { [keyA]: 1, [keyB]: 2 } },
    });
    const entries = Object.entries(projected.envelope.data as Record<string, unknown>);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map(([key]) => key)).size).toBe(2);
    expect(entries.map(([, value]) => value).sort()).toEqual([1, 2]);
  });

  it("projects large Unicode and nested payloads under the documented prompt budget", () => {
    const projected = projectCustomerAgentContinuation({
      type: "external_action_result",
      envelope: {
        ...envelope,
        actionType: "  " + "عملية-".repeat(200),
        reason: "理由-".repeat(300),
        data: {
          z: "😀".repeat(5_000),
          a: Array.from({ length: 100 }, (_, index) => ({
            index,
            nested: { text: "معلومة".repeat(1_000) },
          })),
        },
      },
    });

    const bytes = Buffer.byteLength(JSON.stringify(projected), "utf8");
    expect(bytes).toBeLessThanOrEqual(CUSTOMER_AGENT_CONTINUATION_LIMITS.maxBytes);
    expect(projected.envelope.actionType.length)
      .toBeLessThanOrEqual(CUSTOMER_AGENT_CONTINUATION_LIMITS.maxActionTypeLength);
    expect(projected.envelope.reason.length)
      .toBeLessThanOrEqual(CUSTOMER_AGENT_CONTINUATION_LIMITS.maxReasonLength);
    expect(JSON.stringify(projected)).toContain(CUSTOMER_AGENT_CONTINUATION_LIMITS.truncationMarker);
  });

  it("rejects cyclic and unsupported continuation data before a run is created", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => projectCustomerAgentContinuation({
      type: "external_action_result",
      envelope: { ...envelope, data: cyclic },
    })).toThrow(/JSON|cycle/i);

    expect(() => projectCustomerAgentContinuation({
      type: "external_action_result",
      envelope: { ...envelope, data: { amount: BigInt(1) } },
    })).toThrow(/JSON|unsupported/i);
  });
});
