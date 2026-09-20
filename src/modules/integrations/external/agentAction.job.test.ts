import { beforeEach, describe, expect, it, vi } from "vitest";

const agentMocks = vi.hoisted(() => ({
  executeCustomerTurn: vi.fn(),
  applyCustomerDecision: vi.fn(),
  classifyCustomerDeliveryError: vi.fn((error: unknown) => error),
}));
const executorMocks = vi.hoisted(() => ({ executeExternalQuery: vi.fn() }));
const deliveryMocks = vi.hoisted(() => ({
  decryptFacebookSecret: vi.fn((value: string) => `decrypted:${value}`),
  sendMessengerReply: vi.fn(),
  sendWhatsAppReply: vi.fn(),
}));
const workflowMocks = vi.hoisted(() => ({
  listActiveAgentActionWorkflows: vi.fn(),
  nextMutationSourceForCompletedLookup: vi.fn(),
}));
const runMocks = vi.hoisted(() => ({
  markIntegrationActionRunRunning: vi.fn(),
  markIntegrationActionRunSkipped: vi.fn(),
  markIntegrationActionRunFailed: vi.fn(),
  markIntegrationActionRunSucceeded: vi.fn(),
}));

vi.mock("@config/prisma", () => ({
  default: {
    agentActionSource: { findFirst: vi.fn() },
    conversation: { findFirst: vi.fn() },
    integrationActionRun: { findUnique: vi.fn() },
    agentActionWorkflow: { findFirst: vi.fn() },
    conversationMessage: { findFirst: vi.fn() },
    whatsAppAccount: { findFirst: vi.fn() },
    facebookPage: { findFirst: vi.fn() },
  },
}));
vi.mock("@modules/auth/core/tokenCrypto", () => ({
  decryptFacebookSecret: deliveryMocks.decryptFacebookSecret,
}));
vi.mock("@modules/ai-agent/customer/customerAgent.service", () => agentMocks);
vi.mock("@modules/ai-agent/customer/customerDecision.service", () => agentMocks);
vi.mock("./agentActionExecutor.service", () => executorMocks);
vi.mock("./agentActionWorkflow.service", () => workflowMocks);
vi.mock("./integrationActionRun.service", () => runMocks);
vi.mock("@utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@modules/ai-agent/client/agent.client", () => ({
  AgentClient: { runCapability: vi.fn() },
}));
vi.mock("@modules/meta/core/conversation.service", () => ({
  getConversationHistory: vi.fn().mockResolvedValue([]),
  saveMessage: vi.fn(),
}));
vi.mock("@modules/follow-up/followUp.service", () => ({
  scheduleConversationFollowUps: vi.fn(),
}));
vi.mock("@modules/meta/messenger/messenger.service", () => ({
  sendMessengerReply: deliveryMocks.sendMessengerReply,
}));
vi.mock("@modules/meta/whatsapp/whatsapp.service", () => ({
  sendWhatsAppReply: deliveryMocks.sendWhatsAppReply,
}));

import prisma from "@config/prisma";
import {
  processIntegrationActionJob,
  type IntegrationActionJob,
} from "./agentAction.job";

const mockedPrisma = prisma as any;

describe("integration action customer continuation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.agentActionSource.findFirst.mockResolvedValue({ id: 22 });
    mockedPrisma.conversation.findFirst.mockResolvedValue({
      id: 45,
      businessProfileId: 10,
      channel: "web",
      pageId: "widget:1",
      senderId: "visitor-1",
      externalId: null,
      businessProfile: { userId: 7, name: "Training", voice: "Direct", tone: "Warm" },
    });
    mockedPrisma.integrationActionRun.findUnique.mockResolvedValue(null);
    mockedPrisma.agentActionWorkflow.findFirst.mockResolvedValue(null);
    mockedPrisma.conversationMessage.findFirst.mockResolvedValue(null);
    executorMocks.executeExternalQuery.mockResolvedValue({
      success: true,
      verification: "verified",
      actionType: "integration_action_22",
      reason: "data_returned",
      data: { available: true },
    });
    workflowMocks.listActiveAgentActionWorkflows.mockResolvedValue([]);
    agentMocks.executeCustomerTurn.mockResolvedValue({
      agentTurnId: 303,
      threadId: "thread-45",
      runId: "run-action",
      decision: {
        action: "REPLY",
        content: "Yes, it is available.",
        reason_code: "KNOWLEDGE_MATCH",
        handoff_category: null,
      },
    });
    agentMocks.applyCustomerDecision.mockResolvedValue({
      action: "REPLY",
      delivery: "sent",
      message: { id: 901 },
    });
    deliveryMocks.sendWhatsAppReply.mockResolvedValue({ messages: [{ id: "wamid-a" }] });
    deliveryMocks.sendMessengerReply.mockResolvedValue({ message_id: "mid-a" });
  });

  it("continues a completed external action through the persistent customer coordinator", async () => {
    const job: IntegrationActionJob = {
      businessProfileId: 10,
      trigger: "CHAT_REQUESTED",
      sourceId: 22,
      actionRunId: 81,
      conversationId: 45,
      latestUserText: "Is it available?",
    };

    await processIntegrationActionJob(job);

    expect(agentMocks.executeCustomerTurn).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      businessProfileId: 10,
      conversationId: 45,
      channel: "web",
      customerText: "",
      continuation: {
        type: "external_action_result",
        envelope: {
          success: true,
          verification: "verified",
          actionType: "integration_action_22",
          reason: "data_returned",
          data: { available: true },
        },
      },
      runMode: "inbound",
      dedupeKey: "integration-action:81:action",
    }));
    expect(agentMocks.applyCustomerDecision).toHaveBeenCalledWith(expect.objectContaining({
      businessProfileId: 10,
      conversationId: 45,
      agentTurnId: 303,
      origin: "integration_action_result",
      decision: expect.objectContaining({ action: "REPLY" }),
      deliver: expect.any(Function),
    }));

    const { deliver } = agentMocks.applyCustomerDecision.mock.calls[0][0];
    await expect(deliver({
      id: 901,
      conversationId: 45,
      agentTurnId: 303,
      content: "Yes, it is available.",
      status: "SENDING",
      externalId: null,
    })).resolves.toEqual({
      externalId: null,
    });
    expect(runMocks.markIntegrationActionRunSucceeded).toHaveBeenCalledWith(expect.objectContaining({
      id: 81,
      resultMessageId: 901,
    }));
  });

  it("passes the complete external envelope to the coordinator for one boundary projection", async () => {
    const completeData = { raw: "😀".repeat(5_000) };
    executorMocks.executeExternalQuery.mockResolvedValueOnce({
      success: true,
      verification: "verified",
      actionType: "integration_action_22",
      reason: "data_returned",
      data: completeData,
    });

    await processIntegrationActionJob({
      businessProfileId: 10,
      trigger: "CHAT_REQUESTED",
      sourceId: 22,
      actionRunId: 81,
      conversationId: 45,
    });

    expect(agentMocks.executeCustomerTurn).toHaveBeenCalledWith(expect.objectContaining({
      continuation: expect.objectContaining({
        envelope: expect.objectContaining({ data: completeData }),
      }),
    }));
  });

  it("delivers WhatsApp replies with the credential owned by the conversation profile", async () => {
    mockedPrisma.conversation.findFirst.mockResolvedValueOnce({
      id: 45,
      businessProfileId: 10,
      channel: "whatsapp",
      pageId: "phone-number-1",
      senderId: "customer-1",
      externalId: null,
      businessProfile: { userId: 7 },
    });
    const accounts = [
      { phoneNumberId: "phone-number-1", businessProfileId: 20, accessToken: "tenant-b-token", isActive: true },
      { phoneNumberId: "phone-number-1", businessProfileId: 10, accessToken: "tenant-a-token", isActive: true },
    ];
    mockedPrisma.whatsAppAccount.findFirst.mockImplementation(({ where }: any) => Promise.resolve(
      accounts.find((account) =>
        account.phoneNumberId === where.phoneNumberId &&
        account.isActive !== false &&
        (where.businessProfileId === undefined || account.businessProfileId === where.businessProfileId),
      ),
    ));

    await processIntegrationActionJob({
      businessProfileId: 10,
      trigger: "CHAT_REQUESTED",
      sourceId: 22,
      actionRunId: 81,
      conversationId: 45,
    });

    const { deliver } = agentMocks.applyCustomerDecision.mock.calls[0][0];
    await expect(deliver({
      id: 901,
      conversationId: 45,
      agentTurnId: 303,
      content: "Yes, it is available.",
      status: "SENDING",
      externalId: null,
    })).resolves.toEqual({ externalId: "wamid-a" });

    expect(mockedPrisma.whatsAppAccount.findFirst).toHaveBeenCalledWith({
      where: {
        phoneNumberId: "phone-number-1",
        businessProfileId: 10,
        isActive: true,
      },
      select: { accessToken: true },
    });
    expect(deliveryMocks.sendWhatsAppReply).toHaveBeenCalledWith(
      "customer-1",
      "Yes, it is available.",
      "phone-number-1",
      "decrypted:tenant-a-token",
    );
  });

  it("rejects WhatsApp delivery when only a same-identifier account from another profile exists", async () => {
    mockedPrisma.conversation.findFirst.mockResolvedValueOnce({
      id: 45,
      businessProfileId: 10,
      channel: "whatsapp",
      pageId: "phone-number-1",
      senderId: "customer-1",
      externalId: null,
      businessProfile: { userId: 7 },
    });
    mockedPrisma.whatsAppAccount.findFirst.mockImplementation(({ where }: any) => Promise.resolve(
      where.businessProfileId === undefined
        ? { phoneNumberId: "phone-number-1", businessProfileId: 20, accessToken: "tenant-b-token", isActive: true }
        : null,
    ));

    await processIntegrationActionJob({
      businessProfileId: 10,
      trigger: "CHAT_REQUESTED",
      sourceId: 22,
      actionRunId: 81,
      conversationId: 45,
    });

    const { deliver } = agentMocks.applyCustomerDecision.mock.calls[0][0];
    await expect(deliver({
      id: 901,
      conversationId: 45,
      agentTurnId: 303,
      content: "Yes, it is available.",
      status: "SENDING",
      externalId: null,
    })).rejects.toThrow("WhatsApp account not found");
    expect(deliveryMocks.sendWhatsAppReply).not.toHaveBeenCalled();
  });

  it("delivers Messenger replies with the credential owned by the conversation profile", async () => {
    mockedPrisma.conversation.findFirst.mockResolvedValueOnce({
      id: 45,
      businessProfileId: 10,
      channel: "messenger",
      pageId: "page-1",
      senderId: "customer-1",
      externalId: null,
      businessProfile: { userId: 7 },
    });
    const pages = [
      { pageId: "page-1", businessProfileId: 20, pageAccessToken: "tenant-b-token", isActive: true },
      { pageId: "page-1", businessProfileId: 10, pageAccessToken: "tenant-a-token", isActive: true },
    ];
    mockedPrisma.facebookPage.findFirst.mockImplementation(({ where }: any) => Promise.resolve(
      pages.find((page) =>
        page.pageId === where.pageId &&
        page.isActive !== false &&
        (where.businessProfileId === undefined || page.businessProfileId === where.businessProfileId),
      ),
    ));

    await processIntegrationActionJob({
      businessProfileId: 10,
      trigger: "CHAT_REQUESTED",
      sourceId: 22,
      actionRunId: 81,
      conversationId: 45,
    });

    const { deliver } = agentMocks.applyCustomerDecision.mock.calls[0][0];
    await expect(deliver({
      id: 901,
      conversationId: 45,
      agentTurnId: 303,
      content: "Yes, it is available.",
      status: "SENDING",
      externalId: null,
    })).resolves.toEqual({ externalId: "mid-a" });

    expect(mockedPrisma.facebookPage.findFirst).toHaveBeenCalledWith({
      where: {
        pageId: "page-1",
        businessProfileId: 10,
        isActive: true,
      },
      select: { pageAccessToken: true },
    });
    expect(deliveryMocks.sendMessengerReply).toHaveBeenCalledWith(
      "customer-1",
      "Yes, it is available.",
      "decrypted:tenant-a-token",
    );
  });

  it("rejects Messenger delivery when only a same-identifier page from another profile exists", async () => {
    mockedPrisma.conversation.findFirst.mockResolvedValueOnce({
      id: 45,
      businessProfileId: 10,
      channel: "messenger",
      pageId: "page-1",
      senderId: "customer-1",
      externalId: null,
      businessProfile: { userId: 7 },
    });
    mockedPrisma.facebookPage.findFirst.mockImplementation(({ where }: any) => Promise.resolve(
      where.businessProfileId === undefined
        ? { pageId: "page-1", businessProfileId: 20, pageAccessToken: "tenant-b-token", isActive: true }
        : null,
    ));

    await processIntegrationActionJob({
      businessProfileId: 10,
      trigger: "CHAT_REQUESTED",
      sourceId: 22,
      actionRunId: 81,
      conversationId: 45,
    });

    const { deliver } = agentMocks.applyCustomerDecision.mock.calls[0][0];
    await expect(deliver({
      id: 901,
      conversationId: 45,
      agentTurnId: 303,
      content: "Yes, it is available.",
      status: "SENDING",
      externalId: null,
    })).rejects.toThrow("Messenger page not found");
    expect(deliveryMocks.sendMessengerReply).not.toHaveBeenCalled();
  });
});
