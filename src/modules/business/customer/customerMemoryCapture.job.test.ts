import { beforeEach, describe, expect, it, vi } from "vitest";
import { processCustomerMemoryCaptureJob } from "./customerMemoryCapture.job";
import { invokePipelineStructured } from "@modules/ai-agent/core/pipelineRuntime";
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

vi.mock("@modules/ai-agent/core/pipelineRuntime", () => ({
  invokePipelineStructured: vi.fn(),
  invokePipelineText: vi.fn(),
  invokePipelineTextStream: vi.fn(),
  invokePipelineEmbedding: vi.fn(),
  invokePipelineEmbeddingQuery: vi.fn(),
  invokePipelineImageGen: vi.fn(),
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
    vi.mocked(invokePipelineStructured).mockResolvedValue({
      result: {
        profileUpdates: { name: "Hesham", phone: null, email: null },
        fieldUpdates: { requested_program: "Life coaching" },
        notes: "Customer wants registration details.",
      },
      raw: "",
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        groundingCalls: 0,
        model: "test",
        provider: "google",
      },
    });

    await processCustomerMemoryCaptureJob({
      businessProfileId: 10,
      conversationId: 45,
      latestUserText: "عاوز أسجل",
      recentTurns: [],
    });

    const call = vi.mocked(invokePipelineStructured).mock.calls[0][0];
    expect(call.pipeline).toBe("memory_capture");
    expect(call.prompt).toContain("message 12");
    expect(call.prompt).toContain("requested_program");
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
    vi.mocked(invokePipelineStructured).mockRejectedValue(new Error("timeout"));

    await processCustomerMemoryCaptureJob({
      businessProfileId: 10,
      conversationId: 45,
      latestUserText: "hello",
      recentTurns: [],
    });

    expect(updateCustomerFromSavedDetails).not.toHaveBeenCalled();
  });
});
