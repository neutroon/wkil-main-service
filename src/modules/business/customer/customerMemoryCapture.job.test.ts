import { beforeEach, describe, expect, it, vi } from "vitest";
import { processCustomerMemoryCaptureJob } from "./customerMemoryCapture.job";
import { generateContent } from "@modules/ai-agent/gemini";
import { updateCustomerFromSavedDetails } from "./customer.service";

vi.mock("@config/prisma", () => ({
  default: {
    businessProfile: {
      findUnique: vi.fn(),
    },
    conversation: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@modules/ai-agent/gemini", () => ({
  generateContent: vi.fn(),
}));

vi.mock("./customer.service", () => ({
  updateCustomerFromSavedDetails: vi.fn(),
}));

vi.mock("@utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import prisma from "@config/prisma";

const mockedPrisma = prisma as any;

describe("customer memory capture job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.businessProfile.findUnique.mockResolvedValue({
      name: "Training programs",
      identity: "University-backed training programs",
      voice: "Egyptian Arabic",
      tone: "Professional",
      customerDetailsInstructions: "Save requested program and preferred contact time.",
      customerMemoryFields: [
        {
          key: "requested_program",
          label: "Requested program",
          description: "The course or program the customer wants.",
        },
        { key: "", label: "", description: "" },
        { key: "", label: "", description: "" },
      ],
    });
    mockedPrisma.conversation.findFirst.mockResolvedValue({
      id: 45,
      channel: "messenger",
      customerPhone: null,
      customerName: null,
      customer: {
        displayName: "Customer",
        phone: null,
        email: null,
        notes: null,
        capturedFields: {},
      },
      messages: Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "model",
        content: `message ${index + 1}`,
        createdAt: new Date(),
      })),
    });
  });

  it("extracts memory with AI and saves the structured result locally", async () => {
    vi.mocked(generateContent).mockResolvedValue({
      text: JSON.stringify({
        profileUpdates: { name: "Hesham" },
        fieldUpdates: { requested_program: "Life coaching" },
        notes: "Customer wants registration details.",
      }),
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        groundingCalls: 0,
        model: "test",
      },
    });

    await processCustomerMemoryCaptureJob({
      businessProfileId: 10,
      conversationId: 45,
      latestUserText: "عاوز أسجل",
      recentTurns: [],
    });

    const prompt = vi.mocked(generateContent).mock.calls[0][0];
    expect(prompt).toContain("message 12");
    expect(prompt).toContain("requested_program");
    expect(updateCustomerFromSavedDetails).toHaveBeenCalledWith({
      businessProfileId: 10,
      conversationId: 45,
      details: {
        name: "Hesham",
        requested_program: "Life coaching",
        notes: "Customer wants registration details.",
      },
    });
  });

  it("skips saving when the AI extractor fails", async () => {
    vi.mocked(generateContent).mockRejectedValue(new Error("timeout"));

    await processCustomerMemoryCaptureJob({
      businessProfileId: 10,
      conversationId: 45,
      latestUserText: "hello",
      recentTurns: [],
    });

    expect(updateCustomerFromSavedDetails).not.toHaveBeenCalled();
  });
});
