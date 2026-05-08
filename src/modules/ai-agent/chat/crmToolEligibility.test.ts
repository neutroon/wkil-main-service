import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateContent } from "@modules/ai-agent/gemini";
import { shouldExposeCrmTool } from "./crmToolEligibility";

vi.mock("@modules/ai-agent/gemini", () => ({
  generateContent: vi.fn(),
}));

const integration = {
  id: 1,
  provider: "webhook",
  isActive: true,
  fieldMapping: {
    interest: {
      type: "STRING",
      source: "AI_DERIVED",
      required: false,
      description: "Customer's lead interest",
    },
    phone: {
      type: "STRING",
      source: "USER_PROVIDED",
      required: true,
      description: "Customer phone number",
    },
  },
} as any;

function usage() {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    groundingCalls: 0,
    model: "test",
  };
}

describe("shouldExposeCrmTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hides CRM for pricing questions", async () => {
    vi.mocked(generateContent).mockResolvedValue({
      text: JSON.stringify({
        expose: false,
        reasoning: "Pricing question should be answered or looked up, not captured as a lead.",
      }),
      usage: usage(),
    });

    await expect(
      shouldExposeCrmTool({
        latestUserMessage: "what are prices",
        integration,
      }),
    ).resolves.toBe(false);
  });

  it("exposes CRM for explicit callback/contact intent", async () => {
    vi.mocked(generateContent).mockResolvedValue({
      text: JSON.stringify({
        expose: true,
        reasoning: "User asked for a callback and provided contact intent.",
      }),
      usage: usage(),
    });

    await expect(
      shouldExposeCrmTool({
        latestUserMessage: "please call me tomorrow about the subscription",
        integration,
      }),
    ).resolves.toBe(true);
  });

  it("hides CRM when router output is invalid", async () => {
    vi.mocked(generateContent).mockResolvedValue({
      text: "not-json",
      usage: usage(),
    });

    await expect(
      shouldExposeCrmTool({
        latestUserMessage: "call me",
        integration,
      }),
    ).resolves.toBe(false);
  });

  it("hides inactive CRM without calling the router", async () => {
    await expect(
      shouldExposeCrmTool({
        latestUserMessage: "call me",
        integration: { ...integration, isActive: false },
      }),
    ).resolves.toBe(false);

    expect(generateContent).not.toHaveBeenCalled();
  });
});
