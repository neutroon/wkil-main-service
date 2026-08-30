import { beforeEach, describe, expect, it, vi } from "vitest";
import { processCustomerMemoryCaptureJob } from "./customerMemoryCapture.job";
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

vi.mock("@modules/ai-agent/client/agent.client", () => ({
  AgentClient: {
    runCopilot: vi.fn().mockResolvedValue({ text: "" }),
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

  it("routes through AgentClient.runCopilot and never calls updateCustomerFromSavedDetails", async () => {
    // Memory-capture AI moved to the sibling agent-svc microservice; the
    // monolith only routes the request via AgentClient.
    await processCustomerMemoryCaptureJob({
      businessProfileId: 10,
      conversationId: 45,
      latestUserText: "عاوز أسجل",
      recentTurns: [],
    });

    expect(updateCustomerFromSavedDetails).not.toHaveBeenCalled();
  });
});
