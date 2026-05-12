import { beforeEach, describe, expect, it, vi } from "vitest";
import { findSemanticallyEligibleExternalDataSources } from "@modules/integrations/external/externalActionSemanticIndex.service";
import {
  filterEligibleExternalDataSources,
  validateChatRequestedExternalAction,
} from "./externalToolEligibility";

vi.mock("@modules/integrations/external/externalActionSemanticIndex.service", () => ({
  findSemanticallyEligibleExternalDataSources: vi.fn(),
}));

const priceSource = {
  id: 2,
  businessProfileId: 1,
  name: "product subscriptions price",
  description: "fetch only if user asks about the price",
  isActive: true,
  trigger: "CHAT_REQUESTED",
  actionType: "LOOKUP",
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
  businessProfileId: 1,
  name: "order status lookup",
  description: "Use when customer asks to check delivery status by order ID",
  isActive: true,
  trigger: "CHAT_REQUESTED",
  actionType: "LOOKUP",
  expectedParamsSchema: {
    orderId: {
      type: "STRING",
      source: "USER_PROVIDED",
      required: true,
      description: "Order ID from the customer",
    },
  },
} as any;

describe("external tool eligibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the semantic DB router instead of a generative AI router", async () => {
    vi.mocked(findSemanticallyEligibleExternalDataSources).mockResolvedValue([
      priceSource,
    ]);

    await expect(
      filterEligibleExternalDataSources(
        [priceSource, orderSource],
        "what is the subscription price?",
        {
          businessProfileId: 1,
          queryEmbedding: [0.1, 0.2, 0.3],
        },
      ),
    ).resolves.toEqual([priceSource]);

    expect(findSemanticallyEligibleExternalDataSources).toHaveBeenCalledWith(
      expect.objectContaining({
        businessProfileId: 1,
        sources: [priceSource, orderSource],
        queryEmbedding: [0.1, 0.2, 0.3],
      }),
    );
  });

  it("fails closed when no query embedding is available", async () => {
    await expect(
      filterEligibleExternalDataSources([priceSource], "what is the price?", {
        businessProfileId: 1,
        queryEmbedding: null,
      }),
    ).resolves.toEqual([]);

    expect(findSemanticallyEligibleExternalDataSources).not.toHaveBeenCalled();
  });

  it("fails closed for empty customer messages", async () => {
    await expect(
      filterEligibleExternalDataSources([priceSource], "   ", {
        businessProfileId: 1,
        queryEmbedding: [0.1],
      }),
    ).resolves.toEqual([]);

    expect(findSemanticallyEligibleExternalDataSources).not.toHaveBeenCalled();
  });

  it("accepts a chat-requested action when required user values are present", async () => {
    await expect(
      validateChatRequestedExternalAction({
        source: priceSource,
        latestUserMessage: "what is the price for pagesPilot services?",
        args: { propertyName: "pagesPilot services" },
      }),
    ).resolves.toEqual({
      shouldQueue: true,
      reasoning: "Deterministic action validation passed.",
    });
  });

  it("rejects missing required parameters", async () => {
    await expect(
      validateChatRequestedExternalAction({
        source: priceSource,
        latestUserMessage: "what is the price?",
        args: {},
      }),
    ).resolves.toMatchObject({
      shouldQueue: false,
      reasoning: "Missing required parameters: propertyName",
    });
  });

  it("rejects invented user-provided parameter values", async () => {
    await expect(
      validateChatRequestedExternalAction({
        source: orderSource,
        latestUserMessage: "can you check my order status?",
        args: { orderId: "ABC-123" },
      }),
    ).resolves.toMatchObject({
      shouldQueue: false,
      reasoning: "unprovided_parameter:orderId",
    });
  });

  it("allows user-provided values from trusted recent history", async () => {
    await expect(
      validateChatRequestedExternalAction({
        source: orderSource,
        latestUserMessage: "can you check my order status?",
        historyText: "My order ID is ABC-123",
        args: { orderId: "ABC-123" },
      }),
    ).resolves.toMatchObject({
      shouldQueue: true,
    });
  });

  it("rejects inactive or non-chat-requested sources", async () => {
    await expect(
      validateChatRequestedExternalAction({
        source: { ...priceSource, isActive: false },
        latestUserMessage: "what is the price?",
        args: { propertyName: "price" },
      }),
    ).resolves.toMatchObject({ shouldQueue: false });

    await expect(
      validateChatRequestedExternalAction({
        source: { ...priceSource, trigger: "CUSTOMER_DETAILS_SAVED" },
        latestUserMessage: "what is the price?",
        args: { propertyName: "price" },
      }),
    ).resolves.toMatchObject({ shouldQueue: false });
  });
});
