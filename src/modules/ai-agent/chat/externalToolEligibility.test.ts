import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateContent } from "@modules/ai-agent/gemini";
import { filterEligibleExternalDataSources } from "./externalToolEligibility";

vi.mock("@modules/ai-agent/gemini", () => ({
  generateContent: vi.fn(),
}));

const priceSource = {
  id: 2,
  name: "product subscriptions price",
  description: "fetch only if user ask about the price",
  isActive: true,
  expectedParamsSchema: {
    propertyName: {
      type: "STRING",
      source: "USER_PROVIDED",
      required: true,
      description: "Specific price or plan the customer asked about",
    },
  },
} as any;

const orderSource = {
  id: 3,
  name: "order status lookup",
  description: "Use when customer asks to check delivery status by order ID",
  isActive: true,
  expectedParamsSchema: {
    orderId: {
      type: "STRING",
      source: "USER_PROVIDED",
      required: true,
      description: "Order ID from the customer",
    },
  },
} as any;

const fastSource = {
  ...priceSource,
  id: 4,
  routingMode: "FAST",
} as any;

describe("external tool eligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses router output to hide tools for broad offer questions", async () => {
    vi.mocked(generateContent).mockResolvedValue({
      text: JSON.stringify({
        eligibleIds: [],
        reasoning: "Broad business-context question, not a live price lookup.",
      }),
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        groundingCalls: 0,
        model: "test",
      },
    });

    await expect(
      filterEligibleExternalDataSources(
        [priceSource],
        "what did pages pilot offer tome",
      ),
    ).resolves.toEqual([]);
  });

  it("exposes fast routing sources without calling the semantic router", async () => {
    await expect(
      filterEligibleExternalDataSources(
        [fastSource],
        "what did pages pilot offer tome",
      ),
    ).resolves.toEqual([fastSource]);

    expect(generateContent).not.toHaveBeenCalled();
  });

  it("uses router output to expose matching chat-requested actions", async () => {
    vi.mocked(generateContent).mockResolvedValue({
      text: JSON.stringify({
        eligibleIds: [2],
        reasoning: "User explicitly asked for subscription price.",
      }),
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        groundingCalls: 0,
        model: "test",
      },
    });

    await expect(
      filterEligibleExternalDataSources(
        [priceSource, orderSource],
        "what is the subscription price?",
      ),
    ).resolves.toEqual([priceSource]);
  });

  it("drops inactive sources even if the router returns them", async () => {
    vi.mocked(generateContent).mockResolvedValue({
      text: JSON.stringify({
        eligibleIds: [2],
        reasoning: "User explicitly asked for price.",
      }),
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        groundingCalls: 0,
        model: "test",
      },
    });

    await expect(
      filterEligibleExternalDataSources(
        [{ ...priceSource, isActive: false }],
        "what is the price?",
      ),
    ).resolves.toEqual([]);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("safely exposes no tools when router output is invalid", async () => {
    vi.mocked(generateContent).mockResolvedValue({
      text: "not-json",
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        groundingCalls: 0,
        model: "test",
      },
    });

    await expect(
      filterEligibleExternalDataSources([priceSource], "what is the price?"),
    ).resolves.toEqual([]);
  });

  it("keeps fast sources available when strict router output is invalid", async () => {
    vi.mocked(generateContent).mockResolvedValue({
      text: "not-json",
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        groundingCalls: 0,
        model: "test",
      },
    });

    await expect(
      filterEligibleExternalDataSources(
        [fastSource, priceSource],
        "what is the price?",
      ),
    ).resolves.toEqual([fastSource]);
  });

  it("ignores router ids that are not in the active source set", async () => {
    vi.mocked(generateContent).mockResolvedValue({
      text: JSON.stringify({
        eligibleIds: [999, 3],
        reasoning: "Only order source is valid.",
      }),
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        groundingCalls: 0,
        model: "test",
      },
    });

    await expect(
      filterEligibleExternalDataSources(
        [priceSource, orderSource],
        "can you check my order status?",
      ),
    ).resolves.toEqual([orderSource]);
  });
});
