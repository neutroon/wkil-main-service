import { describe, expect, it } from "vitest";
import {
  initialCustomerReplyStatus,
  shouldAutoDeliverCustomerReply,
} from "./deliveryPolicy";

describe("customer reply delivery policy", () => {
  it("delivers normal replies immediately", () => {
    const reply = { action: "REPLY_AUTO" as const, handoffCategory: null };

    expect(shouldAutoDeliverCustomerReply(reply)).toBe(true);
    expect(initialCustomerReplyStatus(reply)).toBe("SENDING");
    expect(initialCustomerReplyStatus(reply, "web")).toBe("SENT");
  });

  it("delivers customer-facing handoff replies as normal messages", () => {
    expect(
      shouldAutoDeliverCustomerReply(
        { action: "HANDOFF_TO_HUMAN", handoffCategory: "SALES_OPPORTUNITY" },
      ),
    ).toBe(true);

    expect(
      initialCustomerReplyStatus(
        { action: "HANDOFF_TO_HUMAN", handoffCategory: "SALES_OPPORTUNITY" },
      ),
    ).toBe("SENDING");

    expect(
      initialCustomerReplyStatus(
        { action: "HANDOFF_TO_HUMAN", handoffCategory: "MISSING_KNOWLEDGE" },
      ),
    ).toBe("SENDING");
  });

  it("does not deliver system errors to customers", () => {
    expect(
      initialCustomerReplyStatus(
        { action: "REPLY_AUTO", handoffCategory: "SYSTEM_ERROR" },
      ),
    ).toBe("FAILED");
  });
});
