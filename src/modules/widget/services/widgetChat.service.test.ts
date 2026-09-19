import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  businessProfile: { findUniqueOrThrow: vi.fn() },
  agentTurn: { update: vi.fn() },
}));
const conversationMock = vi.hoisted(() => ({
  getOrCreateConversation: vi.fn(),
  saveMessage: vi.fn(),
}));
const customerTurnMock = vi.hoisted(() => ({
  prepareCustomerTurn: vi.fn(),
  finalizeCustomerTurn: vi.fn(),
}));
const decisionMock = vi.hoisted(() => ({ applyCustomerDecision: vi.fn() }));
const agentClientMock = vi.hoisted(() => ({ joinCustomerRun: vi.fn() }));
const mediaLibraryMock = vi.hoisted(() => ({ resolveAssetForChannel: vi.fn() }));

vi.mock("@config/prisma", () => ({ default: prismaMock }));
vi.mock("@modules/meta/core/conversation.service", () => conversationMock);
vi.mock("@modules/ai-agent/customer/customerAgent.service", () => customerTurnMock);
vi.mock("@modules/ai-agent/customer/customerDecision.service", () => decisionMock);
vi.mock("@modules/ai-agent/client/agent.client", () => ({ AgentClient: agentClientMock }));
vi.mock("@modules/business/customer/customer.service", () => ({ upsertCustomerFromConversation: vi.fn() }));
vi.mock("@modules/widget/services/widgetIdentity.service", () => ({ syncVerifiedUserProfile: vi.fn() }));
vi.mock("@modules/media/services/r2Storage.service", () => ({ generateR2Key: vi.fn(), uploadToR2: vi.fn() }));
vi.mock("@modules/media/services/mediaLibrary.service", () => mediaLibraryMock);
vi.mock("@utils/latencyTrace", () => ({
  createLatencyTrace: () => ({ measure: async (_label: string, fn: () => unknown) => fn(), measureDb: async (_label: string, fn: () => unknown) => fn() }),
}));

import { processWidgetChatMessage } from "./widgetChat.service";

const install = {
  id: 1,
  userId: 7,
  businessProfileId: 10,
  publicSiteKey: "wsk_test_xxxxxxxx",
  identitySecret: "secret",
  allowedOrigins: ["https://shop.example"],
  isActive: true,
  settings: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as any;

describe("processWidgetChatMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conversationMock.getOrCreateConversation.mockResolvedValue({ id: 45, aiEnabled: true });
    conversationMock.saveMessage.mockResolvedValue({ id: 99 });
    prismaMock.businessProfile.findUniqueOrThrow.mockResolvedValue({ id: 10, userId: 7, agentActionSources: [] });
    customerTurnMock.prepareCustomerTurn.mockResolvedValue({ agentTurnId: 8, threadId: "thread-1", runId: "run-1" });
    customerTurnMock.finalizeCustomerTurn.mockResolvedValue(undefined);
    agentClientMock.joinCustomerRun.mockResolvedValue({
      action: "REPLY", content: "Welcome", reason_code: "KNOWLEDGE_MATCH", handoff_category: null,
    });
    prismaMock.agentTurn.update.mockResolvedValue({ id: 8 });
    decisionMock.applyCustomerDecision.mockResolvedValue({
      action: "REPLY", delivery: "sent", message: { id: 100, content: "Welcome" },
    });
  });

  it("prepares the tenant-scoped web turn and returns the applied structured action", async () => {
    await expect(processWidgetChatMessage({
      install,
      visitorId: "visitor-123",
      message: "Hello",
    })).resolves.toEqual({
      reply: "Welcome",
      conversationId: 45,
      action: "REPLY",
      attachment: null,
    });

    expect(customerTurnMock.prepareCustomerTurn).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      businessProfileId: 10,
      conversationId: 45,
      channel: "web",
      inputMessageId: 99,
      customerText: "Hello",
      dedupeKey: "message:99",
    }));
    expect(agentClientMock.joinCustomerRun).toHaveBeenCalledWith("thread-1", "run-1");
    expect(decisionMock.applyCustomerDecision).toHaveBeenCalledWith(expect.objectContaining({
      businessProfileId: 10,
      conversationId: 45,
      agentTurnId: 8,
      decision: expect.objectContaining({ action: "REPLY" }),
      deliver: expect.any(Function),
    }));
  });

  it("does not mark a completed customer run failed when applying its decision fails", async () => {
    decisionMock.applyCustomerDecision.mockRejectedValueOnce(new Error("delivery failed"));

    await expect(processWidgetChatMessage({
      install,
      visitorId: "visitor-123",
      message: "Hello",
    })).rejects.toThrow("delivery failed");

    expect(customerTurnMock.finalizeCustomerTurn).toHaveBeenCalledTimes(1);
    expect(prismaMock.agentTurn.update).toHaveBeenCalledWith({
      where: { id: 8 },
      data: {
        decision: expect.objectContaining({ action: "REPLY" }),
        status: "COMPLETED",
        failureReason: null,
      },
    });
    expect(prismaMock.agentTurn.update).not.toHaveBeenCalledWith({
      where: { id: 8 },
      data: expect.objectContaining({ status: "FAILED" }),
    });
  });

  it("fails and releases the prepared turn when the final decision is invalid", async () => {
    agentClientMock.joinCustomerRun.mockResolvedValueOnce({
      action: "REPLY",
      content: null,
      reason_code: "KNOWLEDGE_MATCH",
      handoff_category: null,
    });

    await expect(processWidgetChatMessage({
      install,
      visitorId: "visitor-123",
      message: "Hello",
    })).rejects.toThrow();

    expect(customerTurnMock.finalizeCustomerTurn).toHaveBeenCalledOnce();
    expect(prismaMock.agentTurn.update).toHaveBeenCalledWith({
      where: { id: 8 },
      data: { status: "FAILED", failureReason: "CUSTOMER_AGENT_FAILURE" },
    });
  });

  it("fails and releases the prepared turn when durable history finalization fails", async () => {
    customerTurnMock.finalizeCustomerTurn
      .mockRejectedValueOnce(new Error("history unavailable"))
      .mockResolvedValueOnce(undefined);

    await expect(processWidgetChatMessage({
      install,
      visitorId: "visitor-123",
      message: "Hello",
    })).rejects.toThrow("history unavailable");

    expect(customerTurnMock.finalizeCustomerTurn).toHaveBeenCalledTimes(2);
    expect(prismaMock.agentTurn.update).toHaveBeenCalledWith({
      where: { id: 8 },
      data: { status: "FAILED", failureReason: "CUSTOMER_AGENT_FAILURE" },
    });
  });

  it("marks the prepared turn failed when persisting durable completion fails", async () => {
    prismaMock.agentTurn.update
      .mockRejectedValueOnce(new Error("completion persistence unavailable"))
      .mockResolvedValueOnce({ id: 8 });

    await expect(processWidgetChatMessage({
      install,
      visitorId: "visitor-123",
      message: "Hello",
    })).rejects.toThrow("completion persistence unavailable");

    expect(customerTurnMock.finalizeCustomerTurn).toHaveBeenCalledTimes(2);
    expect(prismaMock.agentTurn.update).toHaveBeenLastCalledWith({
      where: { id: 8 },
      data: { status: "FAILED", failureReason: "CUSTOMER_AGENT_FAILURE" },
    });
    expect(decisionMock.applyCustomerDecision).not.toHaveBeenCalled();
  });

  it("finalizes history seeding and records a redacted failure when the exact run join fails", async () => {
    const aborted = Object.assign(new Error("socket contained secret provider data"), {
      code: "CUSTOMER_AGENT_RUN_ABORTED",
    });
    agentClientMock.joinCustomerRun.mockRejectedValueOnce(aborted);

    await expect(processWidgetChatMessage({
      install,
      visitorId: "visitor-123",
      message: "Hello",
    })).rejects.toBe(aborted);

    expect(customerTurnMock.finalizeCustomerTurn).toHaveBeenCalledOnce();
    expect(prismaMock.agentTurn.update).toHaveBeenCalledWith({
      where: { id: 8 },
      data: {
        status: "FAILED",
        failureReason: "CUSTOMER_AGENT_RUN_ABORTED",
      },
    });
    expect(prismaMock.agentTurn.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ failureReason: expect.stringContaining("secret") }) }),
    );
  });

  it("resolves a requested attachment through the web delivery adapter", async () => {
    agentClientMock.joinCustomerRun.mockResolvedValueOnce({
      action: "REPLY",
      content: "See the brochure",
      reason_code: "KNOWLEDGE_MATCH",
      handoff_category: null,
      attachment: { asset_name: "brochure", caption: "Details" },
    });
    mediaLibraryMock.resolveAssetForChannel.mockResolvedValueOnce({
      url: "https://cdn.example/brochure.pdf",
      mediaType: "document",
    });
    decisionMock.applyCustomerDecision.mockImplementationOnce(async (params: any) => {
      await params.deliver({ id: 100, content: "See the brochure" });
      return {
        action: "REPLY",
        delivery: "sent",
        message: { id: 100, content: "See the brochure" },
      };
    });

    await expect(processWidgetChatMessage({
      install,
      visitorId: "visitor-123",
      message: "Send the brochure",
    })).resolves.toEqual({
      reply: "See the brochure",
      conversationId: 45,
      action: "REPLY",
      attachment: {
        url: "https://cdn.example/brochure.pdf",
        type: "document",
        caption: "Details",
      },
    });

    expect(mediaLibraryMock.resolveAssetForChannel).toHaveBeenCalledWith("brochure", 10, "web");
  });
});
