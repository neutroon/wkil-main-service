import { describe, expect, it } from "vitest";
import { generatePendingLookupStatusDecision } from "./pendingLookupStatus";

describe("generatePendingLookupStatusDecision", () => {
  it("returns a deterministic English progress update without an AI call", async () => {
    const result = await generatePendingLookupStatusDecision({
      businessName: "PagesPilot",
      voice: "English",
      tone: "Friendly",
      channel: "web",
      latestUserText: "Do you have the pro plan available?",
      source: {
        name: "Product availability",
        description: "Checks current product availability.",
      },
    });

    expect(result).toMatchObject({
      action: "REPLY_AUTO",
      content: "Got it. I’m checking the details now and will follow up shortly.",
      requiresGrounding: false,
      grounded: true,
      usedChunkTypes: [],
      missingInfo: null,
    });
  });

  it("returns Arabic copy when the business voice or message is Arabic", async () => {
    const result = await generatePendingLookupStatusDecision({
      businessName: "البرامج التدريبية",
      voice: "Egyptian Arabic",
      latestUserText: "شوف المقاعد المتاحة",
    });

    expect(result.content).toBe(
      "تمام يا فندم، هراجع التفاصيل المتاحة وأرجع لحضرتك حالاً.",
    );
  });
});
