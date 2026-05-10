import { describe, expect, it } from "vitest";
import {
  initialCustomerReplyStatus,
  shouldAutoDeliverCustomerReply,
} from "./deliveryPolicy";

describe("customer reply delivery policy", () => {
  it("auto-delivers normal replies in auto mode", () => {
    const reply = { action: "REPLY_AUTO" as const, handoffCategory: null };

    expect(shouldAutoDeliverCustomerReply(reply, true)).toBe(true);
    expect(initialCustomerReplyStatus(reply, true)).toBe("SENDING");
    expect(initialCustomerReplyStatus(reply, true, "web")).toBe("SENT");
  });

  it("auto-delivers customer-facing handoff replies in auto mode", () => {
    expect(
      shouldAutoDeliverCustomerReply(
        { action: "HANDOFF_TO_HUMAN", handoffCategory: "SALES_OPPORTUNITY" },
        true,
      ),
    ).toBe(true);

    expect(
      initialCustomerReplyStatus(
        { action: "HANDOFF_TO_HUMAN", handoffCategory: "SALES_OPPORTUNITY" },
        true,
      ),
    ).toBe("SENDING");

    expect(
      initialCustomerReplyStatus(
        { action: "HANDOFF_TO_HUMAN", handoffCategory: "MISSING_KNOWLEDGE" },
        true,
      ),
    ).toBe("SENDING");
  });

  it("does not auto-deliver system errors or manual-mode replies", () => {
    expect(
      initialCustomerReplyStatus(
        { action: "REPLY_AUTO", handoffCategory: "SYSTEM_ERROR" },
        true,
      ),
    ).toBe("PENDING_REVIEW");

    expect(
      initialCustomerReplyStatus(
        { action: "HANDOFF_TO_HUMAN", handoffCategory: "SALES_OPPORTUNITY" },
        false,
      ),
    ).toBe("PENDING_REVIEW");
  });
});
