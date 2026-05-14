import { beforeEach, describe, expect, it, vi } from "vitest";
import { findSemanticallyEligibleAgentActionSources } from "@modules/integrations/external/agentActionSemanticIndex.service";
import {
  filterEligibleAgentActionSources,
  validateChatRequestedExternalAction,
} from "./externalToolEligibility";

vi.mock("@modules/integrations/external/agentActionSemanticIndex.service", () => ({
  findSemanticallyEligibleAgentActionSources: vi.fn(),
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
    vi.mocked(findSemanticallyEligibleAgentActionSources).mockResolvedValue([
      priceSource,
    ]);

    await expect(
      filterEligibleAgentActionSources(
        [priceSource, orderSource],
        "what is the subscription price?",
        {
          businessProfileId: 1,
          queryEmbedding: [0.1, 0.2, 0.3],
        },
      ),
    ).resolves.toEqual([priceSource]);

    expect(findSemanticallyEligibleAgentActionSources).toHaveBeenCalledWith(
      expect.objectContaining({
        businessProfileId: 1,
        sources: [priceSource, orderSource],
        queryEmbedding: [0.1, 0.2, 0.3],
      }),
    );
  });

  it("fails closed when no query embedding is available", async () => {
    await expect(
      filterEligibleAgentActionSources([priceSource], "what is the price?", {
        businessProfileId: 1,
        queryEmbedding: null,
      }),
    ).resolves.toEqual([]);

    expect(findSemanticallyEligibleAgentActionSources).not.toHaveBeenCalled();
  });

  it("fails closed for empty customer messages", async () => {
    await expect(
      filterEligibleAgentActionSources([priceSource], "   ", {
        businessProfileId: 1,
        queryEmbedding: [0.1],
      }),
    ).resolves.toEqual([]);

    expect(findSemanticallyEligibleAgentActionSources).not.toHaveBeenCalled();
  });

  it("does not expose chat-requested actions for pure greetings", async () => {
    await expect(
      filterEligibleAgentActionSources([priceSource, orderSource], "السلام عليكم", {
        businessProfileId: 1,
        queryEmbedding: [0.1, 0.2, 0.3],
      }),
    ).resolves.toEqual([]);

    expect(findSemanticallyEligibleAgentActionSources).not.toHaveBeenCalled();
  });

  it("still routes actionable messages that start with a greeting", async () => {
    vi.mocked(findSemanticallyEligibleAgentActionSources).mockResolvedValue([
      orderSource,
    ]);

    await expect(
      filterEligibleAgentActionSources(
        [priceSource, orderSource],
        "السلام عليكم عاوز الغي الاوردر 332",
        {
          businessProfileId: 1,
          queryEmbedding: [0.1, 0.2, 0.3],
        },
      ),
    ).resolves.toEqual([orderSource]);

    expect(findSemanticallyEligibleAgentActionSources).toHaveBeenCalled();
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

  it("validates required nested user fields while ignoring server-injected action-result fields", async () => {
    const leadSource = {
      id: 4,
      businessProfileId: 1,
      name: "capture lead",
      description: "Capture a lead after a lookup action selected the program",
      isActive: true,
      trigger: "CHAT_REQUESTED",
      actionType: "MUTATION",
      expectedParamsSchema: {
        selectedProgram: {
          type: "OBJECT",
          source: "USER_PROVIDED",
          description: "Selected program details",
          properties: {
            name: {
              type: "STRING",
              source: "USER_PROVIDED",
              required: true,
              description: "Program name from the customer",
            },
            courseId: {
              type: "STRING",
              source: "ACTION_RESULT",
              path: "data.courses.0.id",
              description: "Program id from lookup result",
            },
          },
        },
      },
    } as any;

    await expect(
      validateChatRequestedExternalAction({
        source: leadSource,
        latestUserMessage: "عاوز احجز الدعم النفسى بالفنون",
        args: { selectedProgram: { courseId: "invented-id" } },
      }),
    ).resolves.toMatchObject({
      shouldQueue: false,
      reasoning: "Missing required parameters: selectedProgram.name",
    });

    await expect(
      validateChatRequestedExternalAction({
        source: leadSource,
        latestUserMessage: "عاوز احجز الدعم النفسى بالفنون",
        args: {
          selectedProgram: {
            name: "الدعم النفسى بالفنون",
            courseId: "invented-id",
          },
        },
      }),
    ).resolves.toMatchObject({
      shouldQueue: true,
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
        source: { ...priceSource, trigger: "NOT_CHAT_REQUESTED" as any },
        latestUserMessage: "what is the price?",
        args: { propertyName: "price" },
      }),
    ).resolves.toMatchObject({ shouldQueue: false });
  });
});
