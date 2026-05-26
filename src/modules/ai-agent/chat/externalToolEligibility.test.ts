import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateChatRequestedExternalAction } from "./externalToolEligibility";

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

  it("rejects unscoped lookup actions before they can call broad catalog APIs", async () => {
    await expect(
      validateChatRequestedExternalAction({
        source: {
          ...priceSource,
          expectedParamsSchema: null,
        },
        latestUserMessage: "عاوز احجز برنامج",
        args: {},
      }),
    ).resolves.toMatchObject({
      shouldQueue: false,
      reasoning: "Lookup action is not scoped. Add at least one required parameter before activating it.",
    });
  });

  it("rejects CRM lead capture until required name and phone are available", async () => {
    const leadSource = {
      id: 4,
      businessProfileId: 1,
      name: "send lead to crm",
      description: "Send registration lead after program selection",
      isActive: true,
      trigger: "CHAT_REQUESTED",
      actionType: "MUTATION",
      expectedParamsSchema: {
        name: {
          type: "STRING",
          source: "USER_PROVIDED",
          required: true,
          description: "Customer name",
        },
        phone: {
          type: "STRING",
          source: "USER_PROVIDED",
          required: true,
          description: "Customer phone number",
        },
        selectedProgram: {
          type: "OBJECT",
          source: "AI_DERIVED",
          required: true,
          description: "Selected program details",
        },
      },
    } as any;

    await expect(
      validateChatRequestedExternalAction({
        source: leadSource,
        latestUserMessage: "عاوز احجز برنامج الدعم النفسي",
        args: { selectedProgram: { name: "برنامج الدعم النفسي" } },
      }),
    ).resolves.toMatchObject({
      shouldQueue: false,
      reasoning: "Missing required parameters: name, phone",
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
