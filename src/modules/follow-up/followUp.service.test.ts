import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  processFollowUpJob,
  scheduleConversationFollowUps,
} from "./followUp.service";
import { metaExpressQueue } from "@modules/meta/core/meta.queue";
import { saveMessage } from "@modules/meta/core/conversation.service";

vi.mock("@config/prisma", () => ({
  default: {
    conversation: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    conversationMessage: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    facebookPage: {
      findFirst: vi.fn(),
    },
    whatsAppAccount: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@modules/meta/core/meta.queue", () => ({
  metaExpressQueue: {
    add: vi.fn(),
  },
}));

vi.mock("@modules/meta/core/conversation.service", () => ({
  saveMessage: vi.fn(),
}));

vi.mock("@modules/auth/core/tokenCrypto", () => ({
  decryptFacebookSecret: vi.fn((value) => value),
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
    runCapability: vi.fn().mockResolvedValue({ content: "لسه مهتم بالبرنامج؟" }),
  },
}));

import prisma from "@config/prisma";
import { AgentClient } from "@modules/ai-agent/client/agent.client";

const mockedPrisma = prisma as any;

const baseConversation = {
  id: 45,
  pageId: "widget:1",
  senderId: "visitor-1",
  businessProfileId: 10,
  channel: "web",
  status: "OPEN",
  aiEnabled: true,
  businessProfile: {
    id: 10,
    userId: 7,
    name: "Training programs",
    identity: "University-backed training programs",
    voice: "Egyptian Arabic",
    tone: "Professional",
    targetAudience: "Students",
    followUpEnabled: true,
    followUpMode: "AUTO",
    followUpDelays: [
      { amount: 2, unit: "MINUTES" },
      { amount: 5, unit: "HOURS" },
    ],
  },
  messages: [
    { role: "user", content: "عاوز اعرف التفاصيل", createdAt: new Date("2026-05-10T10:00:00Z") },
    { role: "model", content: "أكيد يا فندم.", createdAt: new Date("2026-05-10T10:00:05Z") },
  ],
};

describe("follow-up service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.conversation.findUnique.mockResolvedValue(baseConversation);
    mockedPrisma.conversation.findFirst.mockResolvedValue(baseConversation);
    mockedPrisma.conversationMessage.findUnique.mockResolvedValue({
      createdAt: new Date("2026-05-10T10:00:05Z"),
      id: 101,
      role: "model",
      status: "SENT",
      origin: null,
      handoffCategory: null,
    });
    mockedPrisma.conversationMessage.count.mockResolvedValue(0);
    mockedPrisma.conversationMessage.findMany.mockResolvedValue([]);
    vi.mocked(saveMessage).mockResolvedValue({ id: 202 } as any);
  });

  it("schedules every configured follow-up delay", async () => {
    await scheduleConversationFollowUps({
      conversationId: 45,
      businessProfileId: 10,
      triggerMessageId: 101,
    });

    expect(metaExpressQueue.add).toHaveBeenCalledTimes(2);
    expect(metaExpressQueue.add).toHaveBeenNthCalledWith(
      1,
      "follow_up",
      expect.objectContaining({
        type: "follow_up",
        payload: expect.objectContaining({ delayIndex: 0 }),
      }),
      expect.objectContaining({
        delay: 120000,
        jobId: "followup-45-101-0",
      }),
    );
    expect(metaExpressQueue.add).toHaveBeenNthCalledWith(
      2,
      "follow_up",
      expect.objectContaining({
        type: "follow_up",
        payload: expect.objectContaining({ delayIndex: 1 }),
      }),
      expect.objectContaining({
        delay: 18000000,
        jobId: "followup-45-101-1",
      }),
    );
  });

  it("passes history to the typed capability and saves an eligible follow-up", async () => {
    mockedPrisma.conversationMessage.findUnique.mockResolvedValueOnce({
      createdAt: new Date("2026-05-10T10:00:05Z"),
      role: "model",
      status: "READ",
      origin: null,
      handoffCategory: null,
    });

    await processFollowUpJob({
      conversationId: 45,
      businessProfileId: 10,
      triggerMessageId: 101,
      delayIndex: 0,
    });

    expect(AgentClient.runCapability).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      businessProfileId: 10,
      operation: "follow_up",
      context: expect.objectContaining({
        history: [
          expect.objectContaining({ content: "عاوز اعرف التفاصيل" }),
          expect.objectContaining({ content: "أكيد يا فندم." }),
        ],
        delay_index: 0,
      }),
    }));
    expect(saveMessage).toHaveBeenCalledWith(45, "model", "لسه مهتم بالبرنامج؟", {
      status: "SENT",
      origin: "follow_up",
    });
  });
});
