import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  conversation: { findFirst: vi.fn(), updateMany: vi.fn() },
  agentTurn: { findFirst: vi.fn() },
  conversationMessage: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
}));
const followUpMock = vi.hoisted(() => ({
  scheduleConversationFollowUps: vi.fn(),
  cancelConversationFollowUps: vi.fn(),
}));
const socketMock = vi.hoisted(() => ({ syncHandoffRequested: vi.fn() }));

vi.mock("@config/prisma", () => ({ default: prismaMock }));
vi.mock("@modules/follow-up/followUp.service", () => followUpMock);
vi.mock("@modules/realtime/socketSync.service", () => socketMock);

import {
  applyCustomerDecision,
  classifyCustomerDeliveryError,
  CustomerDeliveryAmbiguousError,
} from "./customerDecision.service";

const params = {
  businessProfileId: 10,
  conversationId: 45,
  agentTurnId: 8,
  decision: {
    action: "REPLY" as const,
    content: "Welcome",
    reason_code: "KNOWLEDGE_MATCH" as const,
    handoff_category: null,
  },
};

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: 202,
    conversationId: 45,
    agentTurnId: 8,
    content: "Welcome",
    status: "SENDING",
    externalId: null,
    ...overrides,
  };
}

describe("customer decision applier", () => {
  it("classifies uncertain transport failures as ambiguous delivery outcomes", () => {
    const timeout = Object.assign(new Error("socket timed out"), { code: "ETIMEDOUT" });

    expect(classifyCustomerDeliveryError(timeout)).toBeInstanceOf(CustomerDeliveryAmbiguousError);
    expect(classifyCustomerDeliveryError(new Error("provider rejected request")))
      .not.toBeInstanceOf(CustomerDeliveryAmbiguousError);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.conversation.findFirst.mockResolvedValue({ id: 45, businessProfileId: 10 });
    prismaMock.agentTurn.findFirst.mockResolvedValue({ id: 8, businessProfileId: 10, conversationId: 45 });
    prismaMock.conversationMessage.findUnique.mockResolvedValue(null);
    prismaMock.conversationMessage.create.mockResolvedValue(message());
    prismaMock.conversationMessage.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.conversation.updateMany.mockResolvedValue({ count: 1 });
    followUpMock.scheduleConversationFollowUps.mockResolvedValue(undefined);
    followUpMock.cancelConversationFollowUps.mockResolvedValue(0);
  });

  it("persists an outbound message before delivery and schedules follow-ups only after delivery", async () => {
    const deliver = vi.fn().mockResolvedValue({ externalId: "wamid.1" });

    await applyCustomerDecision({ ...params, deliver });

    expect(prismaMock.conversationMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        conversationId: 45,
        agentTurnId: 8,
        role: "model",
        content: "Welcome",
        status: "SENDING",
      }),
    });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ id: 202, status: "SENDING" }));
    expect(prismaMock.conversationMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 202, conversationId: 45, status: "SENDING" }),
      data: { status: "SENT", externalId: "wamid.1" },
    }));
    expect(followUpMock.scheduleConversationFollowUps).toHaveBeenCalledWith({
      businessProfileId: 10, conversationId: 45, triggerMessageId: 202,
    });
  });

  it("does not resend a delivered message or schedule another follow-up", async () => {
    prismaMock.conversationMessage.findUnique.mockResolvedValue(message({ status: "SENT", externalId: "wamid.1" }));
    const deliver = vi.fn();

    const result = await applyCustomerDecision({ ...params, deliver });

    expect(result).toMatchObject({ action: "REPLY", delivery: "already_sent" });
    expect(deliver).not.toHaveBeenCalled();
    expect(followUpMock.scheduleConversationFollowUps).not.toHaveBeenCalled();
  });

  it("does not resend a SENDING message because provider delivery is ambiguous", async () => {
    prismaMock.conversationMessage.findUnique.mockResolvedValue(message({ status: "SENDING" }));
    const deliver = vi.fn();

    const result = await applyCustomerDecision({ ...params, deliver });

    expect(result).toMatchObject({ action: "REPLY", delivery: "pending" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("suppresses delivery when manual takeover wins after agent execution", async () => {
    prismaMock.conversationMessage.updateMany.mockResolvedValueOnce({ count: 0 });
    const deliver = vi.fn();

    const result = await applyCustomerDecision({ ...params, deliver });

    expect(prismaMock.conversationMessage.updateMany).toHaveBeenCalledWith({
      where: {
        id: 202,
        conversationId: 45,
        agentTurnId: 8,
        status: "SENDING",
        conversation: { is: { businessProfileId: 10, aiEnabled: true } },
      },
      data: { status: "SENDING" },
    });
    expect(result).toMatchObject({ action: "REPLY", delivery: "pending" });
    expect(deliver).not.toHaveBeenCalled();
    expect(followUpMock.scheduleConversationFollowUps).not.toHaveBeenCalled();
  });

  it("retries a failed delivery without another model run", async () => {
    prismaMock.conversationMessage.findUnique.mockResolvedValue(message({ status: "FAILED" }));
    const deliver = vi.fn().mockResolvedValue({ externalId: "wamid.retry" });

    await applyCustomerDecision({ ...params, deliver });

    expect(prismaMock.conversationMessage.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ id: 202, status: "FAILED" }),
      data: { status: "SENDING", externalId: null },
    }));
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("marks an outbound message failed when its provider delivery fails", async () => {
    const deliver = vi.fn().mockRejectedValue(new Error("provider unavailable"));

    await expect(applyCustomerDecision({ ...params, deliver })).rejects.toThrow("provider unavailable");

    expect(prismaMock.conversationMessage.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 202, status: "SENDING" }),
      data: { status: "FAILED" },
    }));
    expect(followUpMock.scheduleConversationFollowUps).not.toHaveBeenCalled();
  });

  it("keeps a provider-accepted message ambiguous when local SENT persistence fails", async () => {
    prismaMock.conversationMessage.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error("database unavailable"));
    const deliver = vi.fn().mockResolvedValue({ externalId: "wamid.accepted" });

    await expect(applyCustomerDecision({ ...params, deliver }))
      .rejects.toBeInstanceOf(CustomerDeliveryAmbiguousError);

    expect(deliver).toHaveBeenCalledOnce();
    expect(prismaMock.conversationMessage.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: { status: "FAILED" },
    }));
    expect(followUpMock.scheduleConversationFollowUps).not.toHaveBeenCalled();
  });

  it("keeps a message SENDING when the delivery adapter cannot determine provider outcome", async () => {
    const deliver = vi.fn().mockRejectedValue(new CustomerDeliveryAmbiguousError("provider timed out"));

    await expect(applyCustomerDecision({ ...params, deliver })).rejects.toThrow("provider timed out");

    expect(prismaMock.conversationMessage.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: { status: "FAILED" },
    }));
  });

  it("does not turn a delivered reply into a failed one when follow-up scheduling fails", async () => {
    followUpMock.scheduleConversationFollowUps.mockRejectedValue(new Error("redis unavailable"));
    const deliver = vi.fn().mockResolvedValue({ externalId: "wamid.1" });

    await expect(applyCustomerDecision({ ...params, deliver })).resolves.toMatchObject({
      action: "REPLY", delivery: "sent",
    });

    expect(prismaMock.conversationMessage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { status: "SENT", externalId: "wamid.1" },
    }));
    expect(prismaMock.conversationMessage.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: { status: "FAILED" },
    }));
  });

  it("hands off durably, disables AI, cancels follow-ups, syncs staff, and never delivers", async () => {
    prismaMock.conversationMessage.create.mockResolvedValue(message({ content: "Human handoff requested.", status: "SENT" }));
    const deliver = vi.fn();

    await applyCustomerDecision({
      ...params,
      decision: { action: "HANDOFF", content: null, reason_code: "HUMAN_ACTION_REQUIRED", handoff_category: "SUPPORT" },
      deliver,
    });

    expect(prismaMock.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 45, businessProfileId: 10 },
      data: { aiEnabled: false, status: "OPEN" },
    });
    expect(prismaMock.conversationMessage.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      role: "agent", handoffCategory: "SUPPORT", origin: "customer_agent_handoff", agentTurnId: 8,
    }) });
    expect(socketMock.syncHandoffRequested).toHaveBeenCalledWith(expect.objectContaining({
      businessProfileId: 10, conversationId: 45,
    }));
    expect(deliver).not.toHaveBeenCalled();
  });

  it("resolves without creating or delivering an outbound message", async () => {
    const deliver = vi.fn();

    const result = await applyCustomerDecision({
      ...params,
      decision: { action: "RESOLVE", content: null, reason_code: "CUSTOMER_CLOSED", handoff_category: null },
      deliver,
    });

    expect(result).toEqual({ action: "RESOLVE" });
    expect(prismaMock.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 45, businessProfileId: 10 }, data: { status: "RESOLVED" },
    });
    expect(prismaMock.conversationMessage.create).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("keeps no-reply decisions durable without an outbound message", async () => {
    const deliver = vi.fn();

    const result = await applyCustomerDecision({
      ...params,
      decision: { action: "NO_REPLY", content: null, reason_code: "POLICY_SUPPRESSED", handoff_category: null },
      deliver,
    });

    expect(result).toEqual({ action: "NO_REPLY" });
    expect(prismaMock.conversationMessage.create).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("rejects a decision outside the requested tenant scope before persistence or delivery", async () => {
    prismaMock.conversation.findFirst.mockResolvedValue(null);
    const deliver = vi.fn();

    await expect(applyCustomerDecision({ ...params, deliver })).rejects.toThrow("does not belong to this conversation scope");

    expect(prismaMock.conversationMessage.create).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
});
