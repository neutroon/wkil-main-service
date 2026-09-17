import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelConversationFollowUps,
  processFollowUpJob,
  scheduleConversationFollowUps,
} from "./followUp.service";
import { metaExpressQueue } from "@modules/meta/core/meta.queue";

const agentMocks = vi.hoisted(() => ({
  executeCustomerTurn: vi.fn(),
  applyCustomerDecision: vi.fn(),
}));

vi.mock("@config/prisma", () => ({
  default: {
    conversation: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    conversationMessage: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
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

vi.mock("@modules/ai-agent/customer/customerAgent.service", () => ({
  executeCustomerTurn: agentMocks.executeCustomerTurn,
}));

vi.mock("@modules/ai-agent/customer/customerDecision.service", () => ({
  applyCustomerDecision: agentMocks.applyCustomerDecision,
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

import prisma from "@config/prisma";

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
    mockedPrisma.conversationMessage.findFirst.mockResolvedValue({
      createdAt: new Date("2026-05-10T10:00:05Z"),
      id: 101,
      conversationId: 45,
      role: "model",
      status: "SENT",
      origin: null,
      handoffCategory: null,
    });
    mockedPrisma.conversationMessage.count.mockResolvedValue(0);
    mockedPrisma.conversationMessage.findMany.mockResolvedValue([]);
    vi.mocked(metaExpressQueue.getDelayed).mockResolvedValue([] as any);
    vi.mocked(metaExpressQueue.getWaiting).mockResolvedValue([] as any);
    agentMocks.executeCustomerTurn.mockResolvedValue({
      agentTurnId: 303,
      threadId: "thread-45",
      runId: "run-follow-up",
      decision: {
        action: "REPLY",
        content: "لسه مهتم بالبرنامج؟",
        reason_code: "KNOWLEDGE_MATCH",
        handoff_category: null,
      },
    });
    agentMocks.applyCustomerDecision.mockResolvedValue({ action: "REPLY", delivery: "sent" });
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

  it("continues the persistent customer thread without inserting a fake customer message", async () => {
    mockedPrisma.conversationMessage.findFirst.mockResolvedValueOnce({
      createdAt: new Date("2026-05-10T10:00:05Z"),
      conversationId: 45,
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

    expect(agentMocks.executeCustomerTurn).toHaveBeenCalledWith({
      userId: 7,
      businessProfileId: 10,
      conversationId: 45,
      channel: "web",
      customerText: "",
      runMode: "follow_up",
      followUpIndex: 0,
      dedupeKey: "follow-up:45:101:0",
    });
    expect(agentMocks.applyCustomerDecision).toHaveBeenCalledWith(expect.objectContaining({
      businessProfileId: 10,
      conversationId: 45,
      agentTurnId: 303,
      decision: expect.objectContaining({ action: "REPLY", content: "لسه مهتم بالبرنامج؟" }),
      origin: "follow_up",
      deliver: expect.any(Function),
    }));
  });

  it("reuses the deterministic turn identity and completed decision on retry", async () => {
    const payload = {
      conversationId: 45,
      businessProfileId: 10,
      triggerMessageId: 101,
      delayIndex: 1,
    };

    await processFollowUpJob(payload);
    await processFollowUpJob(payload);

    expect(agentMocks.executeCustomerTurn).toHaveBeenCalledTimes(2);
    expect(agentMocks.executeCustomerTurn).toHaveBeenNthCalledWith(1, expect.objectContaining({
      dedupeKey: "follow-up:45:101:1",
    }));
    expect(agentMocks.executeCustomerTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({
      dedupeKey: "follow-up:45:101:1",
    }));
    expect(agentMocks.applyCustomerDecision).toHaveBeenNthCalledWith(1, expect.objectContaining({
      agentTurnId: 303,
    }));
    expect(agentMocks.applyCustomerDecision).toHaveBeenNthCalledWith(2, expect.objectContaining({
      agentTurnId: 303,
    }));
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

    expect(agentMocks.executeCustomerTurn).toHaveBeenCalledOnce();
    expect(mockedPrisma.conversation.findFirst).toHaveBeenCalledTimes(2);
    expect(agentMocks.applyCustomerDecision).not.toHaveBeenCalled();
  });

  it("does not start a run after newer customer or human activity", async () => {
    mockedPrisma.conversationMessage.count.mockResolvedValueOnce(1);

    await processFollowUpJob({
      conversationId: 45,
      businessProfileId: 10,
      triggerMessageId: 101,
      delayIndex: 0,
    });

    expect(agentMocks.executeCustomerTurn).not.toHaveBeenCalled();
    expect(agentMocks.applyCustomerDecision).not.toHaveBeenCalled();
  });

  it("does not start a run after the customer opts out", async () => {
    mockedPrisma.conversationMessage.findMany.mockResolvedValueOnce([{ content: "Please stop" }]);

    await processFollowUpJob({
      conversationId: 45,
      businessProfileId: 10,
      triggerMessageId: 101,
      delayIndex: 0,
    });

    expect(agentMocks.executeCustomerTurn).not.toHaveBeenCalled();
  });

  it("does not start a WhatsApp run outside the free-form window", async () => {
    mockedPrisma.conversation.findFirst.mockResolvedValue({ ...baseConversation, channel: "whatsapp" });
    mockedPrisma.conversationMessage.findFirst
      .mockResolvedValueOnce({
        createdAt: new Date("2026-05-10T10:00:05Z"),
        role: "model",
        status: "SENT",
        origin: null,
        handoffCategory: null,
      })
      .mockResolvedValueOnce({ createdAt: new Date("2020-01-01T00:00:00Z") });

    await processFollowUpJob({
      conversationId: 45,
      businessProfileId: 10,
      triggerMessageId: 101,
      delayIndex: 0,
    });

    expect(agentMocks.executeCustomerTurn).not.toHaveBeenCalled();
  });

  it("rechecks newer activity after generation before applying the decision", async () => {
    mockedPrisma.conversationMessage.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);

    await processFollowUpJob({
      conversationId: 45,
      businessProfileId: 10,
      triggerMessageId: 101,
      delayIndex: 0,
    });

    expect(agentMocks.executeCustomerTurn).toHaveBeenCalledOnce();
    expect(agentMocks.applyCustomerDecision).not.toHaveBeenCalled();
  });

  it("rechecks the trigger delivery status after generation", async () => {
    mockedPrisma.conversationMessage.findFirst
      .mockResolvedValueOnce({
        createdAt: new Date("2026-05-10T10:00:05Z"),
        role: "model",
        status: "SENT",
        origin: null,
        handoffCategory: null,
      })
      .mockResolvedValueOnce({
        createdAt: new Date("2026-05-10T10:00:05Z"),
        role: "model",
        status: "FAILED",
        origin: null,
        handoffCategory: null,
      });

    await processFollowUpJob({
      conversationId: 45,
      businessProfileId: 10,
      triggerMessageId: 101,
      delayIndex: 0,
    });

    expect(agentMocks.executeCustomerTurn).toHaveBeenCalledOnce();
    expect(agentMocks.applyCustomerDecision).not.toHaveBeenCalled();
  });

  it.each([
    { status: "RESOLVED", aiEnabled: true },
    { status: "OPEN", aiEnabled: false },
  ])("does not start a run for an ineligible conversation %#", async (override) => {
    mockedPrisma.conversation.findFirst.mockResolvedValueOnce({ ...baseConversation, ...override });

    await processFollowUpJob({
      conversationId: 45,
      businessProfileId: 10,
      triggerMessageId: 101,
      delayIndex: 0,
    });

    expect(agentMocks.executeCustomerTurn).not.toHaveBeenCalled();
  });

  it("rejects a trigger message that does not belong to the queued conversation", async () => {
    mockedPrisma.conversationMessage.findFirst.mockResolvedValue(null);

    await processFollowUpJob({
      conversationId: 45,
      businessProfileId: 10,
      triggerMessageId: 999,
      delayIndex: 0,
    });

    expect(mockedPrisma.conversationMessage.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 999, conversationId: 45 },
    }));
    expect(agentMocks.executeCustomerTurn).not.toHaveBeenCalled();
    expect(agentMocks.applyCustomerDecision).not.toHaveBeenCalled();
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
