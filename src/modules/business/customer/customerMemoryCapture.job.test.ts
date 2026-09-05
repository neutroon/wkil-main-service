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
    runCapability: vi.fn().mockResolvedValue({
      profile_updates: { name: "Salma", phone: null, email: null },
      field_updates: { requested_program: "Data Science" },
      notes: "Prefers evening calls",
    }),
  },
}));

import prisma from "@config/prisma";
import { AgentClient } from "@modules/ai-agent/client/agent.client";

const mockedPrisma = prisma as any;

describe("customer memory capture job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.businessProfile.findUnique.mockResolvedValue({
      userId: 7,
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

  it("runs the typed capability and persists only useful extracted details", async () => {
    await processCustomerMemoryCaptureJob({
      businessProfileId: 10,
      conversationId: 45,
      latestUserText: "عاوز أسجل",
      recentTurns: [],
    });

    expect(AgentClient.runCapability).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      businessProfileId: 10,
      operation: "customer_memory",
      context: expect.objectContaining({
        latest_customer_message: "عاوز أسجل",
        custom_fields: [expect.objectContaining({ key: "requested_program" })],
        recent_messages: expect.arrayContaining([expect.objectContaining({ text: "message 1" })]),
      }),
    }));
    expect(updateCustomerFromSavedDetails).toHaveBeenCalledWith({
      businessProfileId: 10,
      conversationId: 45,
      details: {
        name: "Salma",
        requested_program: "Data Science",
        notes: "Prefers evening calls",
      },
    });
  });
});
