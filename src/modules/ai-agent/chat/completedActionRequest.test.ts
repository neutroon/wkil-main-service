import { describe, expect, it } from "vitest";
import {
  effectiveCustomerRequestText,
  formatCompletedActionRequestMessage,
} from "./completedActionRequest";

describe("completed action request messages", () => {
  it("wraps and extracts the original action request context", () => {
    const message = formatCompletedActionRequestMessage(
      "Recent chat context before the action:\nعاوز احجز برنامج ال TOT\nهشام\n01202840018",
    );

    expect(message).toContain("Original customer request:");
    expect(effectiveCustomerRequestText(message)).toContain("برنامج ال TOT");
    expect(effectiveCustomerRequestText(message)).toContain("01202840018");
  });

  it("bounds very long action request context while preserving the beginning and end", () => {
    const message = formatCompletedActionRequestMessage(
      `program: TOT\n${"middle ".repeat(700)}\nphone: 01202840018`,
    );
    const extracted = effectiveCustomerRequestText(message);

    expect(message.length).toBeLessThan(3_200);
    expect(extracted).toContain("program: TOT");
    expect(extracted).toContain("phone: 01202840018");
    expect(extracted).toContain("middle of action request context omitted");
  });
});
