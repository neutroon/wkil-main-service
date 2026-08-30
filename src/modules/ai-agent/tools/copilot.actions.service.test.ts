import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  conversation: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  whatsAppAccount: { findFirst: vi.fn() },
  facebookPage: { findFirst: vi.fn() },
  businessProfile: { findFirst: vi.fn() },
}));
vi.mock("@config/prisma", () => ({ default: prismaMock }));

const userSvc = vi.hoisted(() => ({ getAccessibleProfileIds: vi.fn() }));
vi.mock("@modules/auth/user/user.service", () => userSvc);

const inboxCtl = vi.hoisted(() => ({
  conversationsController: { getAuthorizedConversation: vi.fn() },
}));
vi.mock("@modules/inbox/inbox.controller", () => inboxCtl);

const convSvc = vi.hoisted(() => ({ listConversationMessages: vi.fn(), saveMessage: vi.fn() }));
vi.mock("@modules/meta/core/conversation.service", () => convSvc);

const customerSvc = vi.hoisted(() => ({
  listCustomers: vi.fn(),
  updateCustomerForUser: vi.fn(),
  reconcileCustomerStatusFromConversations: vi.fn(),
}));
vi.mock("@modules/business/customer/customer.service", () => customerSvc);

const metaSvc = vi.hoisted(() => ({
  sendWhatsAppReply: vi.fn(),
  sendMessengerReply: vi.fn(),
}));
vi.mock("@modules/meta/whatsapp/whatsapp.service", () => metaSvc);
vi.mock("@modules/meta/messenger/messenger.service", () => metaSvc);

const knowledgeSvc = vi.hoisted(() => ({
  listKnowledgeDocuments: vi.fn(),
  createKnowledgeDocument: vi.fn(),
  updateKnowledgeDocument: vi.fn(),
  deleteKnowledgeDocument: vi.fn(),
}));
vi.mock("@modules/business/profile/knowledge.service", () => knowledgeSvc);

const businessAccess = vi.hoisted(() => ({ updateAgentSettingsForUser: vi.fn() }));
vi.mock("@modules/business/profile/businessAccess.service", () => businessAccess);

import {
  listCopilotConversations,
  getCopilotConversationMessages,
  listCopilotCustomers,
  sendCopilotMessage,
  setCopilotConversationStatus,
  toggleCopilotConversationAi,
  markCopilotConversationRead,
  updateCopilotCustomer,
  getAgentSettingsForUser,
  updateAgentSettings,
  listCopilotKnowledge,
  createCopilotKnowledge,
  updateCopilotKnowledge,
  deleteCopilotKnowledge,
} from "./copilot.actions.service";

beforeEach(() => vi.clearAllMocks());

describe("listCopilotConversations", () => {
  it("scopes to accessible profiles and maps the conversation-list envelope", async () => {
    userSvc.getAccessibleProfileIds.mockResolvedValue([3, 4]);
    prismaMock.conversation.findMany.mockResolvedValue([
      {
        id: 42, channel: "whatsapp", status: "OPEN", aiEnabled: true, readAt: null,
        updatedAt: new Date("2026-08-30T10:00:00Z"),
        customer: { id: 9, displayName: "Sara" },
        messages: [{ role: "agent", content: "Hello!", createdAt: new Date() }],
      },
    ]);
    const out = await listCopilotConversations({ userId: 7, limit: 10 });
    expect(userSvc.getAccessibleProfileIds).toHaveBeenCalledWith(7);
    expect(prismaMock.conversation.findMany).toHaveBeenCalledTimes(1);
    const where = prismaMock.conversation.findMany.mock.calls[0][0].where;
    expect(where.businessProfileId).toEqual({ in: [3, 4] });
    expect(out.conversations[0]).toMatchObject({
      id: 42, channel: "whatsapp", status: "OPEN", customerName: "Sara",
    });
    expect(out.envelopes[0]).toMatchObject({ type: "conversation-list", total: 1 });
    expect(out.envelopes[0].conversations[0]).toMatchObject({ id: 42, customerName: "Sara" });
  });

  it("maps channel filter: whatsapp includes legacy null, messenger includes facebook_comment", async () => {
    userSvc.getAccessibleProfileIds.mockResolvedValue([3]);
    prismaMock.conversation.findMany.mockResolvedValue([]);
    await listCopilotConversations({ userId: 7, channel: "whatsapp" });
    const whereA = prismaMock.conversation.findMany.mock.calls[0][0].where;
    expect(whereA.channel).toEqual({ OR: [{ channel: "whatsapp" }, { channel: null }] });

    await listCopilotConversations({ userId: 7, channel: "messenger" });
    const whereB = prismaMock.conversation.findMany.mock.calls[1][0].where;
    expect(whereB.channel).toEqual({ in: ["messenger", "facebook_comment"] });

    await listCopilotConversations({ userId: 7, channel: "web" });
    const whereC = prismaMock.conversation.findMany.mock.calls[2][0].where;
    expect(whereC.channel).toEqual("web");
  });

  it("maps status filter: ARCHIVED exact, others exclude ARCHIVED", async () => {
    userSvc.getAccessibleProfileIds.mockResolvedValue([3]);
    prismaMock.conversation.findMany.mockResolvedValue([]);
    await listCopilotConversations({ userId: 7, status: "ARCHIVED" });
    expect(prismaMock.conversation.findMany.mock.calls[0][0].where.status).toBe("ARCHIVED");
    await listCopilotConversations({ userId: 7, status: "OPEN" });
    expect(prismaMock.conversation.findMany.mock.calls[1][0].where.status).toEqual({ not: "ARCHIVED" });
  });
});

describe("getCopilotConversationMessages", () => {
  it("authorizes via getAuthorizedConversation then reads messages", async () => {
    const convo = { id: 42, channel: "whatsapp", businessProfileId: 3, customer: { displayName: "Sara" } };
    inboxCtl.conversationsController.getAuthorizedConversation.mockResolvedValue(convo);
    convSvc.listConversationMessages.mockResolvedValue({
      data: [{ id: 1, role: "user", content: "hi", createdAt: new Date() }],
      meta: { nextCursor: null, hasMore: false },
    });
    const out = await getCopilotConversationMessages({ userId: 7, conversationId: 42, limit: 20 });
    expect(inboxCtl.conversationsController.getAuthorizedConversation).toHaveBeenCalledWith(7, 42);
    expect(convSvc.listConversationMessages).toHaveBeenCalledWith(42, 20, undefined);
    expect(out.conversation.id).toBe(42);
    expect(out.data).toHaveLength(1);
  });

  it("propagates authorization failure", async () => {
    inboxCtl.conversationsController.getAuthorizedConversation.mockRejectedValue(new Error("Conversation not found or access denied."));
    await expect(getCopilotConversationMessages({ userId: 7, conversationId: 999 }))
      .rejects.toThrow("Conversation not found or access denied.");
  });
});

describe("listCopilotCustomers", () => {
  it("passes q/status/limit to listCustomers", async () => {
    customerSvc.listCustomers.mockResolvedValue({ data: [], meta: { total: 0 } });
    await listCopilotCustomers({ userId: 7, q: "sa", status: "NEW", limit: 5 });
    expect(customerSvc.listCustomers).toHaveBeenCalledWith({ userId: 7, q: "sa", status: "NEW", page: 1, limit: 5 });
  });
});

describe("sendCopilotMessage", () => {
  it("sends via WhatsApp when channel is whatsapp/legacy-null", async () => {
    inboxCtl.conversationsController.getAuthorizedConversation.mockResolvedValue({
      id: 42, channel: "whatsapp", pageId: "PNID", senderId: "1555", customerId: 9,
    });
    prismaMock.whatsAppAccount.findFirst.mockResolvedValue({
      phoneNumberId: "PNID", accessToken: "enc", isActive: true,
    });
    metaSvc.sendWhatsAppReply.mockResolvedValue({ messages: [{ id: "wamid" }] });
    convSvc.saveMessage.mockResolvedValue({ id: 100, content: "Hello!" });
    const out = await sendCopilotMessage({ userId: 7, conversationId: 42, text: "Hello!" });
    expect(metaSvc.sendWhatsAppReply).toHaveBeenCalledWith("1555", "Hello!", "PNID", "enc");
    expect(convSvc.saveMessage).toHaveBeenCalledWith(42, "agent", "Hello!", { externalId: "wamid" });
    expect(out).toMatchObject({ ok: true });
  });

  it("sends via Messenger when channel is messenger", async () => {
    inboxCtl.conversationsController.getAuthorizedConversation.mockResolvedValue({
      id: 42, channel: "messenger", pageId: "PG1", senderId: "PSID",
    });
    prismaMock.facebookPage.findFirst.mockResolvedValue({ pageId: "PG1", pageAccessToken: "enc2", isActive: true });
    metaSvc.sendMessengerReply.mockResolvedValue({ message_id: "mid" });
    convSvc.saveMessage.mockResolvedValue({ id: 101 });
    const out = await sendCopilotMessage({ userId: 7, conversationId: 42, text: "Hey" });
    expect(metaSvc.sendMessengerReply).toHaveBeenCalledWith("PSID", "Hey", "enc2");
    expect(convSvc.saveMessage).toHaveBeenCalledWith(42, "agent", "Hey", { externalId: "mid" });
    expect(out.ok).toBe(true);
  });

  it("saves locally for web conversations (no external send)", async () => {
    inboxCtl.conversationsController.getAuthorizedConversation.mockResolvedValue({
      id: 42, channel: "web", pageId: "widget:inst1",
    });
    convSvc.saveMessage.mockResolvedValue({ id: 102 });
    const out = await sendCopilotMessage({ userId: 7, conversationId: 42, text: "Hi" });
    expect(metaSvc.sendWhatsAppReply).not.toHaveBeenCalled();
    expect(metaSvc.sendMessengerReply).not.toHaveBeenCalled();
    expect(convSvc.saveMessage).toHaveBeenCalledWith(42, "agent", "Hi", { status: "SENT" });
    expect(out.ok).toBe(true);
  });

  it("rejects unknown channel", async () => {
    inboxCtl.conversationsController.getAuthorizedConversation.mockResolvedValue({
      id: 42, channel: "carrier_pigeon",
    });
    await expect(sendCopilotMessage({ userId: 7, conversationId: 42, text: "x" })).rejects.toThrow("unsupported_channel");
  });
});

describe("setCopilotConversationStatus", () => {
  it("authorizes, updates, and reconciles customer status on RESOLVED/OPEN", async () => {
    inboxCtl.conversationsController.getAuthorizedConversation.mockResolvedValue({
      id: 42, channel: "whatsapp", customerId: 9,
    });
    prismaMock.conversation.update.mockResolvedValue({ id: 42, status: "RESOLVED" });
    const out = await setCopilotConversationStatus({ userId: 7, conversationId: 42, status: "RESOLVED" });
    expect(prismaMock.conversation.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { status: "RESOLVED" },
    });
    expect(customerSvc.reconcileCustomerStatusFromConversations).toHaveBeenCalledWith(7, 9);
    expect(out.ok).toBe(true);
  });

  it("does not reconcile on ARCHIVED", async () => {
    inboxCtl.conversationsController.getAuthorizedConversation.mockResolvedValue({
      id: 42, channel: "whatsapp", customerId: 9,
    });
    prismaMock.conversation.update.mockResolvedValue({ id: 42, status: "ARCHIVED" });
    await setCopilotConversationStatus({ userId: 7, conversationId: 42, status: "ARCHIVED" });
    expect(customerSvc.reconcileCustomerStatusFromConversations).not.toHaveBeenCalled();
  });
});

describe("toggleCopilotConversationAi / markCopilotConversationRead", () => {
  it("toggles aiEnabled", async () => {
    inboxCtl.conversationsController.getAuthorizedConversation.mockResolvedValue({ id: 42 });
    prismaMock.conversation.update.mockResolvedValue({ id: 42, aiEnabled: false });
    const out = await toggleCopilotConversationAi({ userId: 7, conversationId: 42, enabled: false });
    expect(prismaMock.conversation.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { aiEnabled: false },
    });
    expect(out.ok).toBe(true);
  });

  it("marks read via readAt", async () => {
    inboxCtl.conversationsController.getAuthorizedConversation.mockResolvedValue({ id: 42 });
    prismaMock.conversation.update.mockResolvedValue({ id: 42, readAt: new Date() });
    const out = await markCopilotConversationRead({ userId: 7, conversationId: 42 });
    expect(prismaMock.conversation.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { readAt: expect.any(Date) },
    });
    expect(out.ok).toBe(true);
  });
});

describe("updateCopilotCustomer", () => {
  it("delegates to updateCustomerForUser with mapped fields", async () => {
    customerSvc.updateCustomerForUser.mockResolvedValue({ id: 9, status: "RESOLVED" });
    const out = await updateCopilotCustomer({
      userId: 7, customerId: 9,
      data: { status: "RESOLVED", notes: "VIP", displayName: "Sara A." },
    });
    expect(customerSvc.updateCustomerForUser).toHaveBeenCalledWith(7, 9, {
      status: "RESOLVED", notes: "VIP", displayName: "Sara A.",
    });
    expect(out).toMatchObject({ ok: true, customer: { id: 9 } });
  });
});

describe("agent settings", () => {
  it("returns the bounded prompt-facing settings shape", async () => {
    prismaMock.businessProfile.findFirst.mockResolvedValue({
      id: 3, name: "Acme", voice: "Friendly", tone: "Calm", handoffEnabled: true,
      corePolicies: "No refunds.", aiBehaviorInstructions: "Be brief.",
    });
    const out = await getAgentSettingsForUser({ userId: 7 });
    expect(out.settings).toEqual({
      name: "Acme", voice: "Friendly", tone: "Calm", handoffEnabled: true,
      corePolicies: "No refunds.", aiBehaviorInstructions: "Be brief.",
    });
  });

  it("update delegates with resolved profile id", async () => {
    userSvc.getAccessibleProfileIds.mockResolvedValue([3]);
    businessAccess.updateAgentSettingsForUser.mockResolvedValue({ id: 3, voice: "Calm" });
    const out = await updateAgentSettings({ userId: 7, businessProfileId: 3, patch: { voice: "Calm" } });
    expect(businessAccess.updateAgentSettingsForUser).toHaveBeenCalledWith(7, 3, { voice: "Calm" });
    expect(out.ok).toBe(true);
  });
});

describe("knowledge passthrough", () => {
  it("list scopes to an accessible profile", async () => {
    userSvc.getAccessibleProfileIds.mockResolvedValue([3, 4]);
    knowledgeSvc.listKnowledgeDocuments.mockResolvedValue({ documents: [], envelopes: [] });
    await listCopilotKnowledge({ userId: 7, kind: "faq", limit: 5 });
    expect(knowledgeSvc.listKnowledgeDocuments).toHaveBeenCalledWith(expect.any(Number), { kind: "faq", q: undefined, limit: 5 });
  });

  it("create/update/delete pass the resolved profile id", async () => {
    userSvc.getAccessibleProfileIds.mockResolvedValue([3]);
    knowledgeSvc.createKnowledgeDocument.mockResolvedValue({ id: 9 });
    knowledgeSvc.updateKnowledgeDocument.mockResolvedValue({ id: 9 });
    knowledgeSvc.deleteKnowledgeDocument.mockResolvedValue({ ok: true });
    await createCopilotKnowledge({ userId: 7, kind: "faq", title: "Q", content: "A" });
    await updateCopilotKnowledge({ userId: 7, documentId: 9, content: "new" });
    await deleteCopilotKnowledge({ userId: 7, documentId: 9 });
    expect(knowledgeSvc.createKnowledgeDocument).toHaveBeenCalledWith(expect.any(Number), { kind: "faq", title: "Q", content: "A" });
    expect(knowledgeSvc.updateKnowledgeDocument).toHaveBeenCalledWith(expect.any(Number), 9, { content: "new" });
    expect(knowledgeSvc.deleteKnowledgeDocument).toHaveBeenCalledWith(expect.any(Number), 9);
  });
});
