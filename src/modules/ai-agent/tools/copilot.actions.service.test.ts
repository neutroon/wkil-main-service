import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  conversation: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  whatsAppAccount: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  facebookPage: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  businessProfile: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  businessProfileMedia: { findFirst: vi.fn() },
  contentPlanPost: { findFirst: vi.fn(), update: vi.fn() },
  widgetInstall: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  knowledgeDocument: { createMany: vi.fn(), findMany: vi.fn() },
  user: { update: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("@config/prisma", () => ({ default: prismaMock }));
(prismaMock as any).$transaction = vi.fn(async (fn: (tx: any) => unknown) => fn(prismaMock));

const scraping = vi.hoisted(() => ({ analyzeWebsiteForUser: vi.fn() }));
vi.mock("@modules/scraping/scraping.service", () => scraping);

const agentClient = vi.hoisted(() => ({ AgentClient: { ingestRag: vi.fn() } }));
vi.mock("@modules/ai-agent/client/agent.client", () => agentClient);

const userSvc = vi.hoisted(() => ({
  getAccessibleProfileIds: vi.fn(),
  updateCurrentUserProfile: vi.fn(),
}));
vi.mock("@modules/auth/user/user.service", () => userSvc);

const workspaceSvc = vi.hoisted(() => ({
  requireWorkspaceProfileAccess: vi.fn(async () => ({ workspaceId: 11, role: "owner" })),
  WORKSPACE_MANAGER_ROLES: ["owner", "admin"],
}));
vi.mock("@modules/workspace/workspace.service", () => workspaceSvc);

const fbSvc = vi.hoisted(() => ({
  createPost: vi.fn(),
  schedulePost: vi.fn(),
  getPagePosts: vi.fn(),
  getPostComments: vi.fn(),
  deleteFacebookPost: vi.fn(),
  replyToComment: vi.fn(),
}));
vi.mock("@modules/meta/facebook/facebook.service", () => fbSvc);

const mediaLib = vi.hoisted(() => ({
  listMediaAssets: vi.fn(),
  updateMediaAssetMeta: vi.fn(),
  softDeleteAsset: vi.fn(),
}));
vi.mock("@modules/media/services/mediaLibrary.service", () => mediaLib);

const metaQueue = vi.hoisted(() => ({
  enqueueMetaJob: vi.fn(),
  enqueueMediaSyncJob: vi.fn(),
}));
vi.mock("@modules/meta/core/meta.queue", () => metaQueue);

const orderRepo = vi.hoisted(() => ({
  listManagedOrders: vi.fn(),
  listOrderIntegrations: vi.fn(),
  findOrderIntegrationForProfiles: vi.fn(),
  updateOrderIntegration: vi.fn(),
  findNotificationForManagementRetry: vi.fn(),
  requeueNotificationForRetry: vi.fn(),
  findStoreSyncForManagementRetry: vi.fn(),
  requeueStoreSyncForRetry: vi.fn(),
}));
vi.mock("@modules/order-confirmation/orderConfirmation.repository", () => orderRepo);

const orderQueue = vi.hoisted(() => ({
  enqueueNotificationRetry: vi.fn(),
  enqueueStoreSyncRetry: vi.fn(),
}));
vi.mock("@modules/order-confirmation/orderConfirmation.queue", () => orderQueue);

const waOauth = vi.hoisted(() => ({
  subscribeWebhook: vi.fn(),
  unsubscribeWebhook: vi.fn(),
}));
vi.mock("@modules/meta/whatsapp/whatsappOauth.service", () => waOauth);

const webhookCache = vi.hoisted(() => ({
  invalidateWhatsAppAccountCache: vi.fn(async () => {}),
  invalidateIdentityCache: vi.fn(async () => {}),
  invalidateFacebookPageCache: vi.fn(async () => {}),
}));
vi.mock("@modules/meta/core/webhookCache.service", () => webhookCache);

const widgetIdentity = vi.hoisted(() => ({
  generateIdentitySecret: vi.fn(() => "wis_test_secret"),
}));
vi.mock("@modules/widget/services/widgetIdentity.service", () => widgetIdentity);

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

const contentCopilot = vi.hoisted(() => ({
  listCopilotContentPlans: vi.fn(),
  getCopilotContentPlan: vi.fn(),
  generateCopilotContentPlan: vi.fn(),
  generateCopilotPostContent: vi.fn(),
  approveContentPost: vi.fn(),
  deleteCopilotContentPlan: vi.fn(),
}));
vi.mock("@modules/content/contentCopilot.service", () => contentCopilot);

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
  copilotListContentPlans,
  copilotGetContentPlan,
  copilotGenerateContentPlan,
  copilotGeneratePostContent,
  copilotApproveContentPost,
  copilotDeleteContentPlan,
  copilotListMedia,
  copilotUpdateMediaAsset,
  copilotDeleteMediaAsset,
  copilotRetryMediaSync,
  copilotGenerateVisual,
  copilotListOrders,
  copilotListOrderIntegrations,
  copilotUpdateOrderIntegration,
  copilotRetryOrderNotification,
  copilotRetryOrderSync,
  copilotListWhatsAppAccounts,
  copilotWhatsAppAccountAction,
  copilotListFacebookPages,
  copilotFacebookPageAction,
  copilotListWidgetInstalls,
  copilotWidgetAction,
  copilotUpdateAccount,
  resolveProfileId,
  copilotAnalyzeBusinessWebsite,
  copilotApplyBusinessProfileDraft,
} from "./copilot.actions.service";
import {
  listCopilotFacebookPages,
  listCopilotPagePosts,
  listCopilotPostComments,
  createCopilotPost,
  deleteCopilotPost,
  replyCopilotComment,
} from "./socialCopilot.service";

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

describe("resolveProfileId", () => {
  it("resolveProfileId surfaces ambiguity instead of silently taking the first profile", async () => {
    userSvc.getAccessibleProfileIds.mockResolvedValue([3, 4]);
    await expect(resolveProfileId(7)).rejects.toThrow("Multiple business profiles");
  });
});

// ---------------------------------------------------------------------------
// Copilot onboarding tools (analyze_website / apply_profile_draft). Both wrap
// the services the dashboard onboarding form already uses — the copilot is a
// second frontend to the same flow, not a separate implementation.
// ---------------------------------------------------------------------------

describe("copilot onboarding", () => {
  it("copilotAnalyzeBusinessWebsite delegates to analyzeWebsiteForUser", async () => {
    scraping.analyzeWebsiteForUser.mockResolvedValue({
      name: "Nile Coffee", voice: "Warm", tone: "Casual",
      expectedUserIntents: [], websiteDocument: { kind: "website", title: "Website", content: "https://x" },
    });
    const out = await copilotAnalyzeBusinessWebsite({ userId: 7, url: "https://nilecoffee.example" });
    expect(out).toMatchObject({ name: "Nile Coffee" });
    expect(scraping.analyzeWebsiteForUser).toHaveBeenCalledWith(7, "https://nilecoffee.example");
  });

  it("copilotAnalyzeBusinessWebsite rejects non-http urls", () => {
    expect(() =>
      copilotAnalyzeBusinessWebsite({ userId: 7, url: "nilecoffee.example" }),
    ).toThrow("Valid website URL required.");
    expect(scraping.analyzeWebsiteForUser).not.toHaveBeenCalled();
  });

  it("copilotApplyBusinessProfileDraft completes the skeleton and ingests", async () => {
    userSvc.getAccessibleProfileIds.mockResolvedValue([3, 4]);
    prismaMock.businessProfile.findFirst.mockResolvedValue({ id: 3, userId: 7, setupCompletedAt: null });
    prismaMock.businessProfile.update.mockResolvedValue({ id: 3, name: "Nile Coffee", setupCompletedAt: new Date() });
    prismaMock.knowledgeDocument.createMany.mockResolvedValue({ count: 1 });
    agentClient.AgentClient.ingestRag.mockResolvedValue({});

    const out = await copilotApplyBusinessProfileDraft({
      userId: 7,
      businessProfileId: 3,
      draft: { name: "Nile Coffee", voice: "Warm", tone: "Casual", expectedUserIntents: [], corePolicies: "No refunds." },
      documents: [{ kind: "website", title: "Website", content: "https://nilecoffee.example" }],
    });

    expect(out.ok).toBe(true);
    expect(prismaMock.businessProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 3 },
        data: expect.objectContaining({
          name: "Nile Coffee",
          setupCompletedAt: expect.any(Date),
        }),
      }),
    );
    expect(prismaMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 7 },
        data: expect.objectContaining({ isBusinessProfileCreated: true }),
      }),
    );
    expect(prismaMock.knowledgeDocument.createMany).toHaveBeenCalledWith({
      data: [{ businessProfileId: 3, kind: "website", title: "Website", content: "https://nilecoffee.example" }],
    });
    expect(agentClient.AgentClient.ingestRag).toHaveBeenCalledWith(
      expect.objectContaining({ business_profile_id: 3, mode: "full" }),
    );
  });

  it("copilotApplyBusinessProfileDraft rejects a completed profile", async () => {
    userSvc.getAccessibleProfileIds.mockResolvedValue([3]);
    prismaMock.businessProfile.findFirst.mockResolvedValue({ id: 3, userId: 7, setupCompletedAt: new Date() });
    await expect(
      copilotApplyBusinessProfileDraft({ userId: 7, draft: { name: "X" } }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("agent settings", () => {
  it("returns the bounded prompt-facing settings shape", async () => {
    prismaMock.businessProfile.findFirst.mockResolvedValue({
      id: 3, name: "Acme", voice: "Friendly", tone: "Calm", handoffEnabled: true,
      corePolicies: "No refunds.", aiBehaviorInstructions: "Be brief.",
      setupCompletedAt: null,
    });
    const out = await getAgentSettingsForUser({ userId: 7 });
    expect(out.settings).toEqual(
      expect.objectContaining({ setupCompleted: false }),
    );
    expect(out.settings).toEqual({
      name: "Acme", voice: "Friendly", tone: "Calm", handoffEnabled: true,
      corePolicies: "No refunds.", aiBehaviorInstructions: "Be brief.",
      setupCompleted: false,
    });
  });

  it("reports setupCompleted when setup is complete", async () => {
    prismaMock.businessProfile.findFirst.mockResolvedValue({
      id: 3, name: "Acme", voice: "Friendly", tone: "Calm", handoffEnabled: true,
      corePolicies: "No refunds.", aiBehaviorInstructions: "Be brief.",
      setupCompletedAt: new Date(),
    });
    const out = await getAgentSettingsForUser({ userId: 7 });
    expect(out.settings).toEqual(
      expect.objectContaining({ setupCompleted: true }),
    );
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
  it("list surfaces profile ambiguity instead of silently guessing", async () => {
    userSvc.getAccessibleProfileIds.mockResolvedValue([3, 4]);
    await expect(listCopilotKnowledge({ userId: 7, kind: "faq", limit: 5 })).rejects.toThrow(
      "Multiple business profiles",
    );
    expect(knowledgeSvc.listKnowledgeDocuments).not.toHaveBeenCalled();
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

describe("content passthrough", () => {
  it("list/get/generate/post/approve/delete delegate to the content copilot service", async () => {
    contentCopilot.listCopilotContentPlans.mockResolvedValue({ plans: [], meta: { total: 0 } });
    contentCopilot.getCopilotContentPlan.mockResolvedValue({ id: 3, posts: [] });
    contentCopilot.generateCopilotContentPlan.mockResolvedValue({ planId: 11, envelopes: [{ type: "content-plan" }] });
    contentCopilot.generateCopilotPostContent.mockResolvedValue({ ok: true, post: { id: 5, status: "generated" } });
    contentCopilot.approveContentPost.mockResolvedValue({ ok: true, post: { id: 5, status: "approved" } });
    contentCopilot.deleteCopilotContentPlan.mockResolvedValue({ ok: true });

    await copilotListContentPlans({ userId: 7, limit: 5 });
    await copilotGetContentPlan({ userId: 7, planId: 3 });
    await copilotGenerateContentPlan({
      userId: 7, businessProfileId: 1, goal: "g", platform: "facebook",
      draft: { posts: [{ scheduled_at: "2026-09-07", topic: "t" }] },
    });
    await copilotGeneratePostContent({ userId: 7, postId: 5, caption: "c", imagePrompt: "i" });
    await copilotApproveContentPost({ userId: 7, postId: 5 });
    await copilotDeleteContentPlan({ userId: 7, planId: 3 });

    expect(contentCopilot.listCopilotContentPlans).toHaveBeenCalledWith({ userId: 7, limit: 5 });
    expect(contentCopilot.getCopilotContentPlan).toHaveBeenCalledWith({ userId: 7, planId: 3 });
    expect(contentCopilot.generateCopilotContentPlan).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, businessProfileId: 1 }));
    expect(contentCopilot.generateCopilotPostContent).toHaveBeenCalledWith({ userId: 7, postId: 5, caption: "c", imagePrompt: "i" });
    expect(contentCopilot.approveContentPost).toHaveBeenCalledWith({ userId: 7, postId: 5 });
    expect(contentCopilot.deleteCopilotContentPlan).toHaveBeenCalledWith({ userId: 7, planId: 3 });
  });

  it("propagates ownership rejections", async () => {
    contentCopilot.getCopilotContentPlan.mockRejectedValue(new Error("Content plan not found"));
    contentCopilot.deleteCopilotContentPlan.mockRejectedValue(new Error("Content plan not found"));
    await expect(copilotGetContentPlan({ userId: 7, planId: 999 })).rejects.toThrow("not found");
    await expect(copilotDeleteContentPlan({ userId: 7, planId: 999 })).rejects.toThrow("not found");
  });
});

// ---------------------------------------------------------------------------
// Social wrapper (socialCopilot.service) — page ownership before any
// facebook.service delegation.
// ---------------------------------------------------------------------------

const OWNED_PAGE = { id: 5, pageId: "PG1", businessProfileId: 3, pageAccessToken: "enc" };

describe("social wrapper — ownership", () => {
  it("rejects posts to foreign pages with 404 before touching facebook.service", async () => {
    prismaMock.facebookPage.findFirst.mockResolvedValue(null);
    await expect(
      createCopilotPost({ userId: 7, pageId: "FOREIGN", text: "hi" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(fbSvc.createPost).not.toHaveBeenCalled();
    expect(fbSvc.schedulePost).not.toHaveBeenCalled();
  });

  it("rejects post listings for foreign pages", async () => {
    prismaMock.facebookPage.findFirst.mockResolvedValue(null);
    await expect(
      listCopilotPagePosts({ userId: 7, pageId: "FOREIGN" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(fbSvc.getPagePosts).not.toHaveBeenCalled();
  });

  it("rejects comments/replies when the comment's page is not owned", async () => {
    prismaMock.facebookPage.findFirst.mockResolvedValue(null);
    await expect(
      listCopilotPostComments({ userId: 7, postId: "FOREIGN_99" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      replyCopilotComment({ userId: 7, commentId: "FOREIGN_99_1", text: "hey" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(fbSvc.getPostComments).not.toHaveBeenCalled();
    expect(fbSvc.replyToComment).not.toHaveBeenCalled();
  });

  it("rejects deletion of posts on foreign pages", async () => {
    prismaMock.facebookPage.findFirst.mockResolvedValue(null);
    await expect(
      deleteCopilotPost({ userId: 7, postId: "FOREIGN_99" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(fbSvc.deleteFacebookPost).not.toHaveBeenCalled();
  });
});

describe("social wrapper — happy paths", () => {
  beforeEach(() => prismaMock.facebookPage.findFirst.mockResolvedValue(OWNED_PAGE));

  it("lists the owner's pages", async () => {
    prismaMock.facebookPage.findMany.mockResolvedValue([OWNED_PAGE]);
    const out = await listCopilotFacebookPages(7);
    expect(prismaMock.facebookPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { facebookAccount: { userId: 7 }, isActive: true } }),
    );
    expect(out.pages).toHaveLength(1);
  });

  it("creates a post on an owned page", async () => {
    fbSvc.createPost.mockResolvedValue({ id: "PG1_9" });
    const out = await createCopilotPost({ userId: 7, pageId: "PG1", text: "Hello", imageUrl: "https://x/y.png" });
    expect(fbSvc.createPost).toHaveBeenCalledWith({ pageId: "PG1", message: "Hello", imageUrl: "https://x/y.png" });
    expect(out).toMatchObject({ ok: true, post: { id: "PG1_9" }, scheduled: false });
  });

  it("schedules when scheduledAt is present", async () => {
    fbSvc.schedulePost.mockResolvedValue({ data: { id: "PG1_10" } });
    const out = await createCopilotPost({
      userId: 7, pageId: "PG1", text: "Later", scheduledAt: "2026-09-07T10:00:00Z",
    });
    expect(fbSvc.schedulePost).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: "PG1", message: "Later", scheduleTime: expect.any(Number) }),
    );
    expect(fbSvc.createPost).not.toHaveBeenCalled();
    expect(out.scheduled).toBe(true);
  });

  it("lists posts and comments for owned pages", async () => {
    fbSvc.getPagePosts.mockResolvedValue({ data: [{ id: "PG1_9" }] });
    fbSvc.getPostComments.mockResolvedValue({ data: [{ id: "PG1_9_1" }] });
    await listCopilotPagePosts({ userId: 7, pageId: "PG1" });
    await listCopilotPostComments({ userId: 7, postId: "PG1_9" });
    expect(fbSvc.getPagePosts).toHaveBeenCalledWith("PG1");
    expect(fbSvc.getPostComments).toHaveBeenCalledWith("PG1_9");
  });

  it("deletes an owned post", async () => {
    fbSvc.deleteFacebookPost.mockResolvedValue(true);
    const out = await deleteCopilotPost({ userId: 7, postId: "PG1_9" });
    expect(fbSvc.deleteFacebookPost).toHaveBeenCalledWith("PG1_9");
    expect(out.ok).toBe(true);
  });

  it("replies to a comment passing pageId + businessProfileId for token pivoting", async () => {
    fbSvc.replyToComment.mockResolvedValue({ id: "PG1_9_1_r" });
    const out = await replyCopilotComment({ userId: 7, commentId: "PG1_9_1", text: "Thanks!" });
    expect(fbSvc.replyToComment).toHaveBeenCalledWith({
      commentId: "PG1_9_1", message: "Thanks!", pageId: "PG1", businessProfileId: 3,
    });
    expect(out.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Media tools.
// ---------------------------------------------------------------------------

describe("copilot media", () => {
  it("lists assets for an accessible profile", async () => {
    userSvc.getAccessibleProfileIds.mockResolvedValue([3]);
    mediaLib.listMediaAssets.mockResolvedValue([{ id: 1 }]);
    const out = await copilotListMedia({ userId: 7, usageScope: "CONTENT_ASSET" });
    expect(mediaLib.listMediaAssets).toHaveBeenCalledWith(expect.any(Number), 7, "CONTENT_ASSET");
    expect(out.assets).toHaveLength(1);
  });

  it("rejects AI refine for foreign assets with 404 before enqueueing", async () => {
    prismaMock.businessProfileMedia.findFirst.mockResolvedValue(null);
    await expect(
      copilotGenerateVisual({ userId: 7, prompt: "make it pop", action: "refine", assetId: 999 }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(metaQueue.enqueueMetaJob).not.toHaveBeenCalled();
  });

  it("refines an owned asset and enqueues visual_refine", async () => {
    prismaMock.businessProfileMedia.findFirst.mockResolvedValue({ id: 4, userId: 7, businessProfileId: 3 });
    metaQueue.enqueueMetaJob.mockResolvedValue(undefined);
    const out = await copilotGenerateVisual({ userId: 7, prompt: "make it pop", action: "refine", assetId: 4 });
    expect(metaQueue.enqueueMetaJob).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "visual_refine",
        businessProfileId: 3,
        mediaId: "4",
        senderId: "7",
      }),
    );
    expect(out).toMatchObject({ ok: true, status: "processing" });
  });

  it("rejects generate-by-postId when the post's plan is foreign", async () => {
    prismaMock.contentPlanPost.findFirst.mockResolvedValue(null);
    await expect(
      copilotGenerateVisual({ userId: 7, prompt: "hero image", action: "generate", postId: 999 }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(metaQueue.enqueueMetaJob).not.toHaveBeenCalled();
  });

  it("generates for an owned post and flips status to generating", async () => {
    prismaMock.contentPlanPost.findFirst.mockResolvedValue({
      id: 8, contentPlan: { businessProfileId: 3, userId: 7 },
    });
    metaQueue.enqueueMetaJob.mockResolvedValue(undefined);
    const out = await copilotGenerateVisual({ userId: 7, prompt: "hero image", action: "generate", postId: 8 });
    expect(prismaMock.contentPlanPost.update).toHaveBeenCalledWith({
      where: { id: 8 }, data: { status: "generating" },
    });
    expect(metaQueue.enqueueMetaJob).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "visual_production", businessProfileId: 3, postId: 8 }),
    );
    expect(out.ok).toBe(true);
  });

  it("updates / deletes / retries owned assets", async () => {
    mediaLib.updateMediaAssetMeta.mockResolvedValue({ id: 4, name: "Renamed" });
    prismaMock.businessProfileMedia.findFirst.mockResolvedValue({ id: 4, userId: 7 });
    await copilotUpdateMediaAsset({ userId: 7, assetId: 4, name: "Renamed" });
    await copilotDeleteMediaAsset({ userId: 7, assetId: 4 });
    await copilotRetryMediaSync({ userId: 7, assetId: 4 });
    expect(mediaLib.updateMediaAssetMeta).toHaveBeenCalledWith(4, 7, { name: "Renamed", instructions: undefined });
    expect(mediaLib.softDeleteAsset).toHaveBeenCalledWith(4, 7);
    expect(metaQueue.enqueueMediaSyncJob).toHaveBeenCalledWith(4);
  });

  it("rejects media retry for foreign assets", async () => {
    prismaMock.businessProfileMedia.findFirst.mockResolvedValue(null);
    await expect(copilotRetryMediaSync({ userId: 7, assetId: 999 })).rejects.toMatchObject({ statusCode: 404 });
    expect(metaQueue.enqueueMediaSyncJob).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Orders tools.
// ---------------------------------------------------------------------------

describe("copilot orders", () => {
  it("lists orders scoped to accessible profiles", async () => {
    userSvc.getAccessibleProfileIds.mockResolvedValue([3, 4]);
    orderRepo.listManagedOrders.mockResolvedValue({ data: [{ id: 1 }], meta: { total: 1 } });
    const out = await copilotListOrders({ userId: 7, status: "PAID" });
    expect(orderRepo.listManagedOrders).toHaveBeenCalledWith(
      expect.objectContaining({ profileIds: [3, 4], status: "PAID" }),
    );
    expect(out.data).toHaveLength(1);
  });

  it("lists order integrations scoped to accessible profiles", async () => {
    userSvc.getAccessibleProfileIds.mockResolvedValue([3]);
    orderRepo.listOrderIntegrations.mockResolvedValue([{ id: 2 }]);
    const out = await copilotListOrderIntegrations({ userId: 7 });
    expect(orderRepo.listOrderIntegrations).toHaveBeenCalledWith({ profileIds: [3], businessProfileId: undefined });
    expect(out.integrations).toHaveLength(1);
  });

  it("updates an owned order integration", async () => {
    userSvc.getAccessibleProfileIds.mockResolvedValue([3]);
    orderRepo.findOrderIntegrationForProfiles.mockResolvedValue({ id: 2, businessProfileId: 3 });
    orderRepo.updateOrderIntegration.mockResolvedValue({ id: 2, isActive: false });
    const out = await copilotUpdateOrderIntegration({ userId: 7, integrationId: 2, isActive: false });
    expect(orderRepo.updateOrderIntegration).toHaveBeenCalledWith({
      id: 2, businessProfileId: 3, data: { isActive: false },
    });
    expect(out.ok).toBe(true);
  });

  it("rejects retry of a foreign notification with 404", async () => {
    userSvc.getAccessibleProfileIds.mockResolvedValue([3]);
    orderRepo.findNotificationForManagementRetry.mockResolvedValue(null);
    await expect(
      copilotRetryOrderNotification({ userId: 7, notificationId: 999 }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(orderQueue.enqueueNotificationRetry).not.toHaveBeenCalled();
  });

  it("surfaces non-failed / already-claimed retries as clean 409 errors", async () => {
    userSvc.getAccessibleProfileIds.mockResolvedValue([3]);
    orderRepo.findNotificationForManagementRetry.mockResolvedValue({
      id: 5, businessProfileId: 3, kind: "CONFIRMATION_REQUEST", status: "SENT",
      order: { id: 1, businessProfileId: 3, status: "AWAITING_CONFIRMATION" },
    });
    await expect(
      copilotRetryOrderNotification({ userId: 7, notificationId: 5 }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("retries a failed notification", async () => {
    userSvc.getAccessibleProfileIds.mockResolvedValue([3]);
    orderRepo.findNotificationForManagementRetry.mockResolvedValue({
      id: 5, businessProfileId: 3, kind: "CONFIRMATION_REQUEST", status: "FAILED",
      order: { id: 1, businessProfileId: 3, status: "AWAITING_CONFIRMATION" },
    });
    orderRepo.requeueNotificationForRetry.mockResolvedValue(true);
    orderQueue.enqueueNotificationRetry.mockResolvedValue(undefined);
    const out = await copilotRetryOrderNotification({ userId: 7, notificationId: 5 });
    expect(orderRepo.requeueNotificationForRetry).toHaveBeenCalledWith(5, 3);
    expect(orderQueue.enqueueNotificationRetry).toHaveBeenCalledWith(5, "management-notification-retry-5");
    expect(out).toMatchObject({ ok: true, queued: true, notificationId: 5 });
  });

  it("retries a failed store sync", async () => {
    userSvc.getAccessibleProfileIds.mockResolvedValue([3]);
    orderRepo.findStoreSyncForManagementRetry.mockResolvedValue({
      id: 6, businessProfileId: 3, status: "FAILED", requestedStatus: "CONFIRMED",
      order: { id: 1, businessProfileId: 3, status: "CONFIRMED" },
    });
    orderRepo.requeueStoreSyncForRetry.mockResolvedValue(true);
    orderQueue.enqueueStoreSyncRetry.mockResolvedValue(undefined);
    const out = await copilotRetryOrderSync({ userId: 7, syncId: 6 });
    expect(orderQueue.enqueueStoreSyncRetry).toHaveBeenCalledWith(6, "management-store-sync-retry-6");
    expect(out).toMatchObject({ ok: true, queued: true, syncId: 6 });
  });
});

// ---------------------------------------------------------------------------
// Channels: WhatsApp / Facebook pages / Widgets.
// ---------------------------------------------------------------------------

describe("copilot channels — whatsapp", () => {
  it("lists active accounts without leaking tokens", async () => {
    prismaMock.whatsAppAccount.findMany.mockResolvedValue([{ id: 4, phoneNumberId: "PNID" }]);
    const out = await copilotListWhatsAppAccounts({ userId: 7, businessProfileId: 3 });
    expect(prismaMock.whatsAppAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isActive: true,
          OR: [{ businessProfileId: 3 }, { userId: 7, businessProfileId: null }],
        },
      }),
    );
    expect(out.accounts).toHaveLength(1);
  });

  it("rejects actions on foreign accounts with 404", async () => {
    prismaMock.whatsAppAccount.findFirst.mockResolvedValue(null);
    await expect(
      copilotWhatsAppAccountAction({ userId: 7, accountId: 999, action: "link", businessProfileId: 3 }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(prismaMock.whatsAppAccount.update).not.toHaveBeenCalled();
  });

  it("links an owned account to an owned profile", async () => {
    prismaMock.whatsAppAccount.findFirst.mockResolvedValue({ id: 4, userId: 7, isActive: true, phoneNumberId: "PNID" });
    prismaMock.businessProfile.findFirst.mockResolvedValue({ id: 3, userId: 7 });
    prismaMock.whatsAppAccount.update.mockResolvedValue({ id: 4, businessProfileId: 3, accessToken: "enc" });
    const out = await copilotWhatsAppAccountAction({
      userId: 7, accountId: 4, action: "link", businessProfileId: 3,
    });
    expect(prismaMock.whatsAppAccount.update).toHaveBeenCalledWith({
      where: { id: 4 }, data: { businessProfileId: 3 },
    });
    expect(out.ok).toBe(true);
    expect(out.account.accessToken).toBeUndefined();
  });

  it("resubscribes the webhook for an owned account", async () => {
    prismaMock.whatsAppAccount.findFirst.mockResolvedValue({
      id: 4, userId: 7, isActive: true, wabaId: "WABA", accessToken: "enc",
    });
    waOauth.subscribeWebhook.mockResolvedValue(undefined);
    const out = await copilotWhatsAppAccountAction({
      userId: 7, accountId: 4, action: "resubscribe", businessProfileId: 3,
    });
    expect(waOauth.subscribeWebhook).toHaveBeenCalledWith("WABA", "enc");
    expect(out.ok).toBe(true);
  });

  it("deactivates an owned account", async () => {
    prismaMock.whatsAppAccount.findFirst.mockResolvedValue({
      id: 4, userId: 7, isActive: true, wabaId: "WABA", accessToken: "enc", phoneNumberId: "PNID",
    });
    prismaMock.whatsAppAccount.update.mockResolvedValue({ id: 4, isActive: false });
    const out = await copilotWhatsAppAccountAction({
      userId: 7, accountId: 4, action: "deactivate", businessProfileId: 3,
    });
    expect(prismaMock.whatsAppAccount.update).toHaveBeenCalledWith({
      where: { id: 4 }, data: { isActive: false },
    });
    expect(out.ok).toBe(true);
  });
});

describe("copilot channels — facebook pages", () => {
  it("lists the active workspace pages", async () => {
    prismaMock.facebookPage.findMany.mockResolvedValue([{ pageId: "PG1" }]);
    const out = await copilotListFacebookPages({ userId: 7, businessProfileId: 3 });
    expect(prismaMock.facebookPage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isActive: true,
          OR: [
            { businessProfileId: 3 },
            { facebookAccount: { userId: 7 }, businessProfileId: null },
          ],
        },
      }),
    );
    expect(out.pages).toHaveLength(1);
  });

  it("rejects actions on foreign pages with 404", async () => {
    prismaMock.facebookPage.findFirst.mockResolvedValue(null);
    await expect(
      copilotFacebookPageAction({
        userId: 7, pageId: "FOREIGN", action: "settings",
        businessProfileId: 3, commentAutoDmEnabled: true,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(prismaMock.facebookPage.update).not.toHaveBeenCalled();
  });

  it("links an owned page to an owned profile", async () => {
    prismaMock.facebookPage.findFirst.mockResolvedValue({ id: 5, pageId: "PG1", businessProfileId: null });
    prismaMock.businessProfile.findFirst.mockResolvedValue({ id: 3, userId: 7 });
    prismaMock.facebookPage.update.mockResolvedValue({ id: 5, businessProfileId: 3 });
    const out = await copilotFacebookPageAction({ userId: 7, pageId: "PG1", action: "link", businessProfileId: 3 });
    expect(prismaMock.facebookPage.update).toHaveBeenCalledWith({
      where: { id: 5 }, data: { businessProfileId: 3 },
    });
    expect(out.ok).toBe(true);
  });

  it("updates settings preserving setupAgentConfiguredAt side effect", async () => {
    prismaMock.facebookPage.findFirst.mockResolvedValue({
      id: 5, pageId: "PG1", commentAutoDmEnabled: false, commentPublicGreeting: "hi",
    });
    prismaMock.facebookPage.update.mockResolvedValue({ id: 5, commentAutoDmEnabled: true });
    const out = await copilotFacebookPageAction({
      userId: 7, pageId: "PG1", action: "settings",
      businessProfileId: 3, commentAutoDmEnabled: true,
    });
    expect(prismaMock.facebookPage.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { commentAutoDmEnabled: true, commentPublicGreeting: "hi" },
    });
    expect(prismaMock.user.updateMany).toHaveBeenCalledWith({
      where: { id: 7, setupAgentConfiguredAt: null },
      data: { setupAgentConfiguredAt: expect.any(Date) },
    });
    expect(out.ok).toBe(true);
  });
});

describe("copilot channels — widgets", () => {
  it("creates a widget install returning publicSiteKey + identitySecret", async () => {
    prismaMock.businessProfile.findFirst.mockResolvedValue({ id: 3, userId: 7 });
    prismaMock.widgetInstall.create.mockResolvedValue({
      id: 9, publicSiteKey: "wsk_abc", identitySecret: "wis_test_secret", allowedOrigins: ["https://a.com"],
    });
    const out = await copilotWidgetAction({
      userId: 7, action: "create", businessProfileId: 3, allowedOrigins: ["https://a.com"],
    });
    expect(prismaMock.widgetInstall.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 7, businessProfileId: 3, publicSiteKey: expect.stringMatching(/^wsk_/),
        identitySecret: "wis_test_secret", allowedOrigins: ["https://a.com"],
      }),
    });
    expect(out.install?.publicSiteKey).toBe("wsk_abc");
    expect(out.install?.identitySecret).toBe("wis_test_secret");
  });

  it("returns the identity secret for an owned install", async () => {
    prismaMock.widgetInstall.findFirst.mockResolvedValue({ identitySecret: "wis_test_secret" });
    const out = await copilotWidgetAction({ userId: 7, action: "identity_secret", installId: 9 });
    expect(out.identitySecret).toBe("wis_test_secret");
  });

  it("rejects widget actions on foreign installs", async () => {
    prismaMock.widgetInstall.findFirst.mockResolvedValue(null);
    await expect(
      copilotWidgetAction({ userId: 7, action: "delete", installId: 999 }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(prismaMock.widgetInstall.delete).not.toHaveBeenCalled();
  });

  it("deletes / deactivates / updates owned installs", async () => {
    prismaMock.widgetInstall.findFirst.mockResolvedValue({ id: 9, userId: 7 });
    prismaMock.widgetInstall.update.mockResolvedValue({ id: 9, isActive: false });
    prismaMock.widgetInstall.delete.mockResolvedValue({ id: 9 });
    await copilotWidgetAction({ userId: 7, action: "deactivate", installId: 9 });
    await copilotWidgetAction({ userId: 7, action: "delete", installId: 9 });
    await copilotWidgetAction({ userId: 7, action: "update", installId: 9, isActive: true });
    expect(prismaMock.widgetInstall.update).toHaveBeenCalledWith({ where: { id: 9 }, data: { isActive: false } });
    expect(prismaMock.widgetInstall.delete).toHaveBeenCalledWith({ where: { id: 9 } });
    expect(prismaMock.widgetInstall.update).toHaveBeenCalledWith({ where: { id: 9 }, data: { isActive: true } });
  });

  it("lists widget installs", async () => {
    prismaMock.widgetInstall.findMany.mockResolvedValue([{ id: 9 }]);
    const out = await copilotListWidgetInstalls(7);
    expect(prismaMock.widgetInstall.findMany).toHaveBeenCalledWith({ where: { userId: 7 }, orderBy: { createdAt: "desc" } });
    expect(out.installs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Account.
// ---------------------------------------------------------------------------

describe("copilot account", () => {
  it("maps name/avatarUrl onto updateCurrentUserProfile", async () => {
    userSvc.updateCurrentUserProfile.mockResolvedValue({ id: 7, name: "Hesham", avatar: "https://a.png" });
    const out = await copilotUpdateAccount({ userId: 7, name: "Hesham", avatarUrl: "https://a.png" });
    expect(userSvc.updateCurrentUserProfile).toHaveBeenCalledWith(7, { name: "Hesham", avatar: "https://a.png" });
    expect(out.ok).toBe(true);
  });
});
