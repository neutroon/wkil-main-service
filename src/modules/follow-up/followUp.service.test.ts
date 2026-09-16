import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelConversationFollowUps,
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
    getDelayed: vi.fn(),
    getWaiting: vi.fn(),
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
    vi.mocked(metaExpressQueue.getDelayed).mockResolvedValue([] as any);
    vi.mocked(metaExpressQueue.getWaiting).mockResolvedValue([] as any);
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

  it("does not persist or deliver when human handoff happens during generation", async () => {
    mockedPrisma.conversation.findFirst
      .mockResolvedValueOnce(baseConversation)
      .mockResolvedValueOnce({ ...baseConversation, aiEnabled: false });

    await processFollowUpJob({
      conversationId: 45,
      businessProfileId: 10,
      triggerMessageId: 101,
      delayIndex: 0,
    });

    expect(AgentClient.runCapability).toHaveBeenCalledOnce();
    expect(mockedPrisma.conversation.findFirst).toHaveBeenCalledTimes(2);
    expect(saveMessage).not.toHaveBeenCalled();
  });

  it("cancels only waiting or delayed follow-up jobs for the selected conversation", async () => {
    const matchingDelayed = {
      id: "followup-45-101-0",
      name: "follow_up",
      data: { type: "follow_up", payload: { conversationId: 45 } },
      getState: vi.fn().mockResolvedValue("delayed"),
      remove: vi.fn(),
    };
    const matchingWaiting = {
      id: "followup-45-101-1",
      name: "follow_up",
      data: { type: "follow_up", payload: { conversationId: 45 } },
      getState: vi.fn().mockResolvedValue("waiting"),
      remove: vi.fn(),
    };
    const activeMatching = {
      id: "followup-45-active",
      name: "follow_up",
      data: { type: "follow_up", payload: { conversationId: 45 } },
      getState: vi.fn().mockResolvedValue("active"),
      remove: vi.fn(),
    };
    const differentConversation = {
      id: "followup-46-101-0",
      name: "follow_up",
      data: { type: "follow_up", payload: { conversationId: 46 } },
      getState: vi.fn(),
      remove: vi.fn(),
    };
    vi.mocked(metaExpressQueue.getDelayed).mockResolvedValue([matchingDelayed, activeMatching, differentConversation] as any);
    vi.mocked(metaExpressQueue.getWaiting).mockResolvedValue([matchingWaiting] as any);

    await expect(cancelConversationFollowUps(45)).resolves.toBe(2);

    expect(matchingDelayed.remove).toHaveBeenCalledOnce();
    expect(matchingWaiting.remove).toHaveBeenCalledOnce();
    expect(activeMatching.remove).not.toHaveBeenCalled();
    expect(differentConversation.remove).not.toHaveBeenCalled();
  });
});
