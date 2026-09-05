import prisma from "@config/prisma";
import { randomBytes } from "crypto";
import {
  getAccessibleProfileIds,
  updateCurrentUserProfile,
} from "@modules/auth/user/user.service";
import { conversationsController } from "@modules/inbox/inbox.controller";
import {
  listConversationMessages,
  saveMessage,
} from "@modules/meta/core/conversation.service";
import { listWhatsAppTemplates, sendWhatsAppReply } from "@modules/meta/whatsapp/whatsapp.service";
import { sendMessengerReply } from "@modules/meta/messenger/messenger.service";
import {
  decryptFacebookSecret,
  encryptFacebookSecret,
  generateRandomToken,
} from "@modules/auth/core/tokenCrypto";
import {
  listCustomers,
  updateCustomerForUser,
  reconcileCustomerStatusFromConversations,
} from "@modules/business/customer/customer.service";
import {
  listKnowledgeDocuments,
  createKnowledgeDocument,
  updateKnowledgeDocument,
  deleteKnowledgeDocument,
} from "@modules/business/profile/knowledge.service";
import { updateAgentSettingsForUser } from "@modules/business/profile/businessAccess.service";
import {
  listCopilotContentPlans,
  getCopilotContentPlan,
  generateCopilotContentPlan,
  generateCopilotPostContent,
  approveContentPost,
  deleteCopilotContentPlan,
} from "@modules/content/contentCopilot.service";
import { AppError } from "@middlewares/errorHandler.middleware";
import { analyzeWebsiteForUser } from "@modules/scraping/scraping.service";
import { AgentClient } from "@modules/ai-agent/client/agent.client";
import {
  listMediaAssets,
  updateMediaAssetMeta,
  softDeleteAsset,
} from "@modules/media/services/mediaLibrary.service";
import { enqueueMediaSyncJob, enqueueMetaJob } from "@modules/meta/core/meta.queue";
import {
  subscribeWebhook,
  unsubscribeWebhook,
} from "@modules/meta/whatsapp/whatsappOauth.service";
import { invalidateWhatsAppAccountCache, invalidateIdentityCache, invalidateFacebookPageCache } from "@modules/meta/core/webhookCache.service";
import { parseAllowedOrigins } from "@modules/widget/widgetInstall.middleware";
import { generateIdentitySecret } from "@modules/widget/services/widgetIdentity.service";
import {
  listManagedOrders,
  findManagedOrder,
  listOrderIntegrations,
  findOrderIntegrationForProfiles,
  createOrderIntegration,
  updateOrderIntegration,
  rotateOrderIntegrationSecret,
  findWhatsAppAccountForProfile,
  listOrderTemplateConfigs,
  findOrderTemplateConfigByIdForProfiles,
  findOrderTemplateConfigForTest,
  createOrderTemplateConfig,
  updateOrderTemplateConfig,
  findNotificationForManagementRetry,
  requeueNotificationForRetry,
  findStoreSyncForManagementRetry,
  requeueStoreSyncForRetry,
} from "@modules/order-confirmation/orderConfirmation.repository";
import {
  renderOrderTemplateVariables,
  validateOrderTemplateMapping,
  type OrderTemplateMapping,
} from "@modules/order-confirmation/orderConfirmation.template.service";
import { normalizeCanonicalOrderEvent } from "@modules/order-confirmation/orderConfirmation.normalizer";
import {
  requireWorkspaceProfileAccess,
  WORKSPACE_MANAGER_ROLES,
} from "@modules/workspace/workspace.service";
import {
  enqueueNotificationRetry,
  enqueueStoreSyncRetry,
} from "@modules/order-confirmation/orderConfirmation.queue";

const AUTHORIZED = (userId: number, conversationId: number) =>
  conversationsController.getAuthorizedConversation(userId, conversationId);

export async function sendCopilotMessage(params: {
  userId: number;
  conversationId: number;
  text: string;
}) {
  const text = params.text.trim();
  if (!text) throw new Error("text_required");
  const conversation = await AUTHORIZED(params.userId, params.conversationId);
  const channel = conversation.channel ?? "whatsapp";
  let externalId: string | undefined;
  if (channel === "whatsapp") {
    const account = await prisma.whatsAppAccount.findFirst({
      where: { phoneNumberId: conversation.pageId, userId: params.userId, isActive: true },
    });
    if (!account) throw new Error("whatsapp_account_not_found");
    const accessToken = decryptFacebookSecret(account.accessToken);
    const sent = await sendWhatsAppReply(conversation.senderId, text, account.phoneNumberId, accessToken);
    externalId = sent?.messages?.[0]?.id;
  } else if (channel === "messenger" || channel === "facebook_comment") {
    const page = await prisma.facebookPage.findFirst({
      where: { pageId: conversation.pageId, isActive: true, facebookAccount: { userId: params.userId } },
    });
    if (!page) throw new Error("facebook_page_not_found");
    const pageAccessToken = decryptFacebookSecret(page.pageAccessToken);
    const sent = await sendMessengerReply(conversation.senderId, text, pageAccessToken);
    externalId = sent?.message_id;
  } else if (channel !== "web") {
    throw new Error("unsupported_channel");
  }
  const message = await saveMessage(params.conversationId, "agent", text, {
    ...(externalId ? { externalId } : {}),
    ...(channel === "web" ? { status: "SENT" as const } : {}),
  });
  return { ok: true, message };
}

export async function setCopilotConversationStatus(params: {
  userId: number;
  conversationId: number;
  status: "OPEN" | "RESOLVED" | "ARCHIVED";
}) {
  const conversation = await AUTHORIZED(params.userId, params.conversationId);
  const updated = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { status: params.status },
  });
  if (conversation.customerId && (params.status === "RESOLVED" || params.status === "OPEN")) {
    await reconcileCustomerStatusFromConversations(params.userId, conversation.customerId);
  }
  return { ok: true, conversation: updated };
}

export async function toggleCopilotConversationAi(params: {
  userId: number;
  conversationId: number;
  enabled: boolean;
}) {
  const conversation = await AUTHORIZED(params.userId, params.conversationId);
  const updated = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { aiEnabled: params.enabled },
  });
  return { ok: true, conversation: updated };
}

export async function markCopilotConversationRead(params: {
  userId: number;
  conversationId: number;
}) {
  const conversation = await AUTHORIZED(params.userId, params.conversationId);
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { readAt: new Date() },
  });
  return { ok: true };
}

export async function updateCopilotCustomer(params: {
  userId: number;
  customerId: number;
  data: { status?: string; notes?: string | null; displayName?: string };
}) {
  const customer = await updateCustomerForUser(params.userId, params.customerId, {
    ...(params.data.status ? { status: params.data.status as any } : {}),
    ...(params.data.notes !== undefined ? { notes: params.data.notes } : {}),
    ...(params.data.displayName ? { displayName: params.data.displayName } : {}),
  });
  return { ok: true, customer };
}

const CONVERSATION_LIST_SELECT = {
  id: true,
  channel: true,
  status: true,
  aiEnabled: true,
  readAt: true,
  updatedAt: true,
  customerId: true,
  customer: { select: { id: true, displayName: true, phone: true } },
  messages: {
    orderBy: { id: "desc" as const },
    take: 1,
    select: { role: true, content: true, createdAt: true },
  },
} as const;

function channelWhere(channel?: string) {
  if (!channel) return undefined;
  if (channel === "whatsapp") return { OR: [{ channel: "whatsapp" }, { channel: null }] };
  if (channel === "messenger") return { in: ["messenger", "facebook_comment"] };
  return channel;
}

function statusWhere(status?: string) {
  if (!status) return undefined;
  return status.toUpperCase() === "ARCHIVED" ? "ARCHIVED" : { not: "ARCHIVED" };
}

export async function listCopilotConversations(params: {
  userId: number;
  businessProfileId?: number;
  status?: string;
  channel?: string;
  q?: string;
  limit?: number;
}) {
  const profileIds = await getAccessibleProfileIds(params.userId);
  const scoped = params.businessProfileId
    ? profileIds.filter((id: number) => id === params.businessProfileId)
    : profileIds;
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
  const conversations = await prisma.conversation.findMany({
    where: {
      businessProfileId: { in: scoped },
      ...(channelWhere(params.channel) ? { channel: channelWhere(params.channel) } : {}),
      ...(statusWhere(params.status) ? { status: statusWhere(params.status) } : {}),
      ...(params.q ? { customer: { displayName: { contains: params.q } } } : {}),
    },
    select: CONVERSATION_LIST_SELECT,
    orderBy: { updatedAt: "desc" },
    take: limit,
  });
  const rows = conversations.map((c: any) => ({
    id: c.id,
    channel: c.channel ?? "whatsapp",
    status: c.status,
    aiEnabled: c.aiEnabled,
    readAt: c.readAt,
    updatedAt: c.updatedAt,
    customerId: c.customerId,
    customerName: c.customer?.displayName ?? null,
    customerPhone: c.customer?.phone ?? null,
    lastMessage: c.messages?.[0]
      ? { role: c.messages[0].role, content: c.messages[0].content, createdAt: c.messages[0].createdAt }
      : null,
  }));
  return {
    conversations: rows,
    envelopes: [
      {
        type: "conversation-list",
        conversations: rows.map((r: any) => ({
          id: r.id,
          customerName: r.customerName,
          channel: r.channel,
          preview: r.lastMessage?.content ?? null,
        })),
        total: rows.length,
        cite: { tool: "list_conversations", fetchedAt: new Date().toISOString(), deepLink: "/inbox" },
      },
    ],
  };
}

export async function getCopilotConversationMessages(params: {
  userId: number;
  conversationId: number;
  limit?: number;
  cursor?: number;
}) {
  const conversation = await conversationsController.getAuthorizedConversation(
    params.userId,
    params.conversationId,
  );
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
  const result = await listConversationMessages(params.conversationId, limit, params.cursor);
  return { conversation, ...result };
}

export async function listCopilotCustomers(params: {
  userId: number;
  q?: string;
  status?: string;
  limit?: number;
}) {
  const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
  return listCustomers({
    userId: params.userId,
    q: params.q,
    status: params.status,
    page: 1,
    limit,
  });
}

const SETTINGS_SELECT = {
  id: true, name: true, voice: true, tone: true, handoffEnabled: true,
  corePolicies: true, aiBehaviorInstructions: true, setupCompletedAt: true,
} as const;

export async function resolveProfileId(userId: number, businessProfileId?: number) {
  const profileIds = await getAccessibleProfileIds(userId);
  const scoped = businessProfileId
    ? profileIds.filter((id: number) => id === businessProfileId)
    : profileIds;
  if (!scoped.length) throw new AppError("Business profile not found.", 404);
  if (scoped.length > 1) {
    throw new AppError(
      "Multiple business profiles found — select one.",
      400,
    );
  }
  return scoped[0];
}

export async function getAgentSettingsForUser(params: { userId: number; businessProfileId?: number }) {
  const profile = await prisma.businessProfile.findFirst({
    where: { userId: params.userId, ...(params.businessProfileId ? { id: params.businessProfileId } : {}) },
    select: SETTINGS_SELECT,
  });
  if (!profile) throw new AppError("Business profile not found.", 404);
  return {
    settings: {
      name: profile.name,
      voice: profile.voice,
      tone: profile.tone,
      handoffEnabled: profile.handoffEnabled,
      corePolicies: profile.corePolicies,
      aiBehaviorInstructions: profile.aiBehaviorInstructions,
      setupCompleted: profile.setupCompletedAt != null,
    },
  };
}

export async function updateAgentSettings(params: {
  userId: number; businessProfileId?: number; patch: Record<string, unknown>;
}) {
  const profileId = await resolveProfileId(params.userId, params.businessProfileId);
  const profile = await updateAgentSettingsForUser(params.userId, profileId, params.patch);
  return { ok: true as const, profile };
}

export async function listCopilotKnowledge(params: {
  userId: number; businessProfileId?: number; kind?: string; q?: string; limit?: number;
}) {
  const profileId = await resolveProfileId(params.userId, params.businessProfileId);
  return listKnowledgeDocuments(profileId, { kind: params.kind, q: params.q, limit: params.limit });
}

export async function createCopilotKnowledge(params: {
  userId: number; businessProfileId?: number; kind: string; title?: string; content: string;
}) {
  const profileId = await resolveProfileId(params.userId, params.businessProfileId);
  const document = await createKnowledgeDocument(profileId, { kind: params.kind, title: params.title, content: params.content });
  return { ok: true as const, document };
}

export async function updateCopilotKnowledge(params: {
  userId: number; businessProfileId?: number; documentId: number; kind?: string; title?: string; content?: string;
}) {
  const profileId = await resolveProfileId(params.userId, params.businessProfileId);
  const document = await updateKnowledgeDocument(profileId, params.documentId, { kind: params.kind, title: params.title, content: params.content });
  return { ok: true as const, document };
}

export async function deleteCopilotKnowledge(params: { userId: number; businessProfileId?: number; documentId: number }) {
  const profileId = await resolveProfileId(params.userId, params.businessProfileId);
  return deleteKnowledgeDocument(profileId, params.documentId);
}

// ---------------------------------------------------------------------------
// Copilot onboarding tools (analyze_website / apply_profile_draft). Both wrap
// the services the dashboard onboarding form already uses — the copilot is a
// second frontend to the same flow, not a separate implementation.
// ---------------------------------------------------------------------------

export function copilotAnalyzeBusinessWebsite(params: { userId: number; url: string }) {
  const url = params.url.trim();
  if (!/^https?:\/\//.test(url)) throw new AppError("Valid website URL required.", 400);
  return analyzeWebsiteForUser(params.userId, url);
}

const ONBOARDING_FIELDS = [
  "name", "voice", "tone", "expectedUserIntents", "corePolicies",
  "aiBehaviorInstructions", "customerDetailsInstructions",
] as const;

export async function copilotApplyBusinessProfileDraft(params: {
  userId: number;
  businessProfileId?: number;
  draft: Record<string, unknown>;
  documents?: { kind: string; title?: string; content: string }[];
}) {
  const profileId = await resolveProfileId(params.userId, params.businessProfileId);
  const profile = await prisma.businessProfile.findFirst({
    where: { id: profileId },
    select: { id: true, setupCompletedAt: true },
  });
  if (!profile) throw new AppError("Business profile not found.", 404);
  if (profile.setupCompletedAt) {
    throw new AppError("Business profile already onboarded.", 409);
  }

  const data: Record<string, unknown> = {
    setupCompletedAt: new Date(),
  };
  for (const field of ONBOARDING_FIELDS) {
    const value = params.draft[field];
    if (value !== undefined && value !== null && value !== "") data[field] = value;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const updatedProfile = await tx.businessProfile.update({
      where: { id: profileId },
      data,
    });
    // isBusinessProfileCreated is a User column (schema line 132).
    await tx.user.update({
      where: { id: params.userId },
      data: { isBusinessProfileCreated: true },
    });
    if (params.documents?.length) {
      await tx.knowledgeDocument.createMany({
        data: params.documents.map((d) => ({
          businessProfileId: profileId,
          kind: d.kind,
          title: d.title ?? null,
          content: d.content,
        })),
      });
    }
    return updatedProfile;
  });

  await AgentClient.ingestRag({
    business_profile_id: profileId,
    documents: await prisma.knowledgeDocument.findMany({
      where: { businessProfileId: profileId },
      select: { id: true, businessProfileId: true, kind: true, title: true, content: true },
    }),
    mode: "full",
  });

  return { ok: true as const, profile: updated };
}

// ---------------------------------------------------------------------------
// Copilot content tools (consumed by agent-svc list_content_plans /
// get_content_plan / generate_content_plan / generate_post_content /
// approve_content_post / delete_content_plan). Thin passthroughs to the
// content copilot service, which owns ownership checks + persistence.
// ---------------------------------------------------------------------------

export function copilotListContentPlans(params: {
  userId: number; businessProfileId?: number; status?: string; limit?: number;
}) {
  return listCopilotContentPlans(params);
}

export function copilotGetContentPlan(params: { userId: number; planId: number }) {
  return getCopilotContentPlan(params);
}

export function copilotGenerateContentPlan(params: {
  userId: number; businessProfileId: number;
  draft: { goals?: string[]; posts: Array<Record<string, unknown>> };
  goal?: string; platform?: string;
}) {
  return generateCopilotContentPlan(params as any);
}

export function copilotGeneratePostContent(params: {
  userId: number; postId: number; caption: string; imagePrompt?: string;
}) {
  return generateCopilotPostContent(params);
}

export function copilotApproveContentPost(params: { userId: number; postId: number }) {
  return approveContentPost(params);
}

export function copilotDeleteContentPlan(params: { userId: number; planId: number }) {
  return deleteCopilotContentPlan(params);
}

// ---------------------------------------------------------------------------
// Copilot media tools (list_media_assets / update_media_asset /
// delete_media_asset / retry_media_sync / generate_media_visual). Ownership is
// re-validated here BEFORE any enqueue — a foreign asset/post is a clean 404.
// ---------------------------------------------------------------------------

export async function copilotListMedia(params: {
  userId: number; businessProfileId?: number; usageScope?: string;
}) {
  const profileId = await resolveProfileId(params.userId, params.businessProfileId);
  const assets = await listMediaAssets(profileId, params.userId, params.usageScope as any);
  return { assets };
}

export async function copilotUpdateMediaAsset(params: {
  userId: number; assetId: number; name?: string; instructions?: string;
}) {
  const asset = await updateMediaAssetMeta(params.assetId, params.userId, {
    ...(params.name !== undefined ? { name: params.name } : {}),
    ...(params.instructions !== undefined ? { instructions: params.instructions } : {}),
  });
  return { ok: true as const, asset };
}

export async function copilotDeleteMediaAsset(params: { userId: number; assetId: number }) {
  await softDeleteAsset(params.assetId, params.userId);
  return { ok: true as const };
}

export async function copilotRetryMediaSync(params: { userId: number; assetId: number }) {
  const asset = await prisma.businessProfileMedia.findFirst({
    where: { id: params.assetId, userId: params.userId },
  });
  if (!asset) throw new AppError("Asset not found", 404);
  await enqueueMediaSyncJob(params.assetId);
  return { ok: true as const, message: "Sync job re-queued" };
}

export async function copilotGenerateVisual(params: {
  userId: number; prompt: string; action: "generate" | "refine"; assetId?: number; postId?: number;
}) {
  let businessProfileId: number;

  if (params.action === "refine") {
    if (!params.assetId) throw new AppError("assetId is required for refinement", 400);
    const asset = await prisma.businessProfileMedia.findFirst({
      where: { id: params.assetId, userId: params.userId },
    });
    if (!asset) throw new AppError("Asset not found", 404);
    businessProfileId = asset.businessProfileId;
  } else if (params.postId) {
    const post = await prisma.contentPlanPost.findFirst({
      where: { id: params.postId, contentPlan: { userId: params.userId } },
      select: { id: true, contentPlan: { select: { businessProfileId: true } } },
    });
    if (!post) throw new AppError("Post not found", 404);
    businessProfileId = post.contentPlan.businessProfileId;
  } else {
    businessProfileId = await resolveProfileId(params.userId);
  }

  if (params.postId) {
    await prisma.contentPlanPost.update({
      where: { id: params.postId },
      data: { status: "generating" },
    });
  }

  const isRefine = params.action === "refine";
  await enqueueMetaJob({
    platform: isRefine ? "visual_refine" : "visual_production",
    type: isRefine ? "visual_refine" : "visual_production",
    identifier: String(businessProfileId),
    senderId: String(params.userId),
    messageText: params.prompt,
    ...(isRefine && params.assetId ? { mediaId: String(params.assetId) } : {}),
    businessProfileId,
    ...(params.postId ? { postId: params.postId } : {}),
  } as any);

  return { ok: true as const, status: "processing" as const };
}

// ---------------------------------------------------------------------------
// Copilot order tools (list_orders / list_order_integrations /
// update_order_integration / retry_order_notification / retry_order_sync).
// Scoped via getAccessibleProfileIds; idempotent retries surface as clean 409s.
// ---------------------------------------------------------------------------

const ORDER_EVENT_TYPE = "order.created";

function assertOrderLocale(locale: string): "ar" | "en" {
  if (locale !== "ar" && locale !== "en") throw new AppError("Locale must be ar or en", 400);
  return locale;
}

function parseOrderCallbackUrl(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new AppError("Invalid status callback URL", 400);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new AppError("Status callback URL must be HTTPS without credentials or fragments", 400);
  }
  return parsed.toString();
}

function encryptOrderSecret(secret: string): string {
  const value = secret.trim();
  if (!value) throw new AppError("Secret must not be blank", 400);
  const encrypted = encryptFacebookSecret(value);
  if (encrypted === value) throw new AppError("Order-confirmation secret encryption is not configured", 500);
  return encrypted;
}

function safeOrderIntegration(record: any) {
  if (!record) return record;
  const {
    signingSecret: _signingSecret,
    previousSigningSecret: _previousSigningSecret,
    statusCallbackSecret: _statusCallbackSecret,
    previousStatusCallbackSecret: _previousStatusCallbackSecret,
    ...safe
  } = record;
  return safe;
}

function templateLanguage(template: any): string {
  const language = template?.languageCode ?? template?.language ?? template?.language_code ?? "";
  return typeof language === "object" && language !== null ? String(language.code ?? "") : String(language);
}

function templateStatus(template: any): string {
  return String(template?.status ?? "").toUpperCase();
}

function templateComponents(template: any): any[] {
  return Array.isArray(template?.components) ? template.components : [];
}

function safeMetaTemplate(template: any) {
  return {
    ...(typeof template?.id === "string" ? { id: template.id } : {}),
    name: String(template?.name ?? ""),
    languageCode: templateLanguage(template),
    status: templateStatus(template),
    category: template?.category ?? null,
    components: templateComponents(template).map((component) => ({
      type: component?.type,
      ...(component?.text === undefined ? {} : { text: component.text }),
      ...(Array.isArray(component?.buttons)
        ? { buttons: component.buttons.map((button: any) => ({ type: button?.type, text: button?.text })) }
        : {}),
    })),
  };
}

async function ownedOrderIntegration(userId: number, integrationId: number) {
  const profileIds = await getAccessibleProfileIds(userId);
  const integration = await findOrderIntegrationForProfiles(integrationId, profileIds);
  if (!integration) throw new AppError("Order integration not found", 404);
  return { profileIds, integration };
}

async function approvedTemplatesForAccount(userId: number, accountId: number) {
  const profileIds = await getAccessibleProfileIds(userId);
  let account = null;
  for (const profileId of profileIds) {
    account = await findWhatsAppAccountForProfile(accountId, profileId);
    if (account) break;
  }
  if (!account) throw new AppError("WhatsApp account not found", 404);
  let accessToken: string;
  try {
    accessToken = decryptFacebookSecret(account.accessToken);
  } catch {
    throw new AppError("WhatsApp account credentials are unavailable", 502);
  }
  const templates = await listWhatsAppTemplates(account.wabaId, accessToken);
  return { account, templates: templates.filter((item) => templateStatus(item) === "APPROVED") };
}

function requireQuickReplyTemplate(template: any, mappingValue: unknown): OrderTemplateMapping {
  const mapping = validateOrderTemplateMapping(mappingValue, true);
  const buttons = templateComponents(template).find(
    (component) => String(component?.type ?? "").toUpperCase() === "BUTTONS",
  )?.buttons;
  if (!Array.isArray(buttons) || buttons.length !== 2 || buttons.some((button: any) => String(button?.type ?? "").toUpperCase() !== "QUICK_REPLY")) {
    throw new AppError("Template must contain Confirm and Cancel quick replies in order", 400);
  }
  const bodyText = templateComponents(template).find(
    (component) => String(component?.type ?? "").toUpperCase() === "BODY",
  )?.text;
  if (typeof bodyText === "string") {
    const indexes = [...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
    const placeholderCount = indexes.length === 0 ? 0 : Math.max(...indexes);
    const rawBody = Array.isArray(mappingValue)
      ? mappingValue
      : (mappingValue as any)?.body ?? mappingValue;
    const mappedCount = Array.isArray(rawBody)
      ? rawBody.length
      : rawBody && typeof rawBody === "object" ? Object.keys(rawBody).length : 0;
    if (placeholderCount !== mappedCount) throw new AppError("Template placeholders must match variable mapping", 400);
  }
  return mapping;
}

export async function copilotListOrders(params: {
  userId: number; businessProfileId?: number; status?: string; page?: number; limit?: number;
}) {
  const profileIds = await getAccessibleProfileIds(params.userId);
  return listManagedOrders({
    profileIds,
    businessProfileId: params.businessProfileId,
    status: params.status,
    page: Math.max(params.page ?? 1, 1),
    limit: Math.min(Math.max(params.limit ?? 20, 1), 50),
  });
}

export async function copilotGetOrder(params: { userId: number; orderId: number }) {
  const profileIds = await getAccessibleProfileIds(params.userId);
  const order = await findManagedOrder(params.orderId, profileIds);
  if (!order) throw new AppError("Order confirmation not found", 404);
  return { order };
}

export async function copilotListOrderIntegrations(params: {
  userId: number; businessProfileId?: number;
}) {
  const profileIds = await getAccessibleProfileIds(params.userId);
  const integrations = await listOrderIntegrations({
    profileIds,
    businessProfileId: params.businessProfileId,
  });
  return { integrations };
}

export async function copilotCreateOrderIntegration(params: {
  userId: number;
  businessProfileId: number;
  whatsappAccountId?: number | null;
  defaultLocale?: string;
  isActive?: boolean;
  storeSyncEnabled?: boolean;
  statusCallbackUrl?: string | null;
  statusCallbackSecret?: string | null;
}) {
  const profileIds = await getAccessibleProfileIds(params.userId);
  if (!profileIds.includes(params.businessProfileId)) throw new AppError("Business profile not found", 404);
  if (params.whatsappAccountId != null) {
    const account = await findWhatsAppAccountForProfile(params.whatsappAccountId, params.businessProfileId);
    if (!account) throw new AppError("WhatsApp account not found", 404);
  }
  const locale = assertOrderLocale(params.defaultLocale ?? "en");
  const callbackUrl = parseOrderCallbackUrl(params.statusCallbackUrl);
  const callbackSecret = params.statusCallbackSecret?.trim() || null;
  if (params.storeSyncEnabled && (!callbackUrl || !callbackSecret)) {
    throw new AppError("Store sync requires an HTTPS callback URL and callback secret", 400);
  }
  const secret = generateRandomToken();
  const record = await createOrderIntegration({
    businessProfileId: params.businessProfileId,
    whatsappAccountId: params.whatsappAccountId ?? null,
    kind: "GENERIC",
    integrationKey: generateRandomToken(),
    signingSecret: encryptOrderSecret(secret),
    statusCallbackUrl: callbackUrl,
    statusCallbackSecret: callbackSecret ? encryptOrderSecret(callbackSecret) : null,
    isActive: params.isActive ?? false,
    storeSyncEnabled: params.storeSyncEnabled ?? false,
    defaultLocale: locale,
  });
  return { ok: true as const, integration: safeOrderIntegration(record), secret };
}

export async function copilotUpdateOrderIntegration(params: {
  userId: number; integrationId: number;
  whatsappAccountId?: number | null;
  isActive?: boolean; storeSyncEnabled?: boolean; defaultLocale?: string;
  statusCallbackUrl?: string | null; statusCallbackSecret?: string | null;
  rotateStatusCallbackSecret?: boolean;
}) {
  const { integration } = await ownedOrderIntegration(params.userId, params.integrationId);
  const data: Record<string, unknown> = {};
  if (params.isActive !== undefined) data.isActive = params.isActive;
  if (params.storeSyncEnabled !== undefined) data.storeSyncEnabled = params.storeSyncEnabled;
  if (params.defaultLocale !== undefined) data.defaultLocale = assertOrderLocale(params.defaultLocale);
  if (params.whatsappAccountId !== undefined) {
    if (params.whatsappAccountId !== null) {
      const account = await findWhatsAppAccountForProfile(params.whatsappAccountId, integration.businessProfileId);
      if (!account) throw new AppError("WhatsApp account not found", 404);
    }
    data.whatsappAccountId = params.whatsappAccountId;
  }
  if (params.statusCallbackUrl !== undefined) data.statusCallbackUrl = parseOrderCallbackUrl(params.statusCallbackUrl);
  let oneTimeCallbackSecret: string | undefined;
  if (params.rotateStatusCallbackSecret) {
    oneTimeCallbackSecret = generateRandomToken();
    data.previousStatusCallbackSecret = integration.statusCallbackSecret;
    data.statusCallbackSecret = encryptOrderSecret(oneTimeCallbackSecret);
  } else if (params.statusCallbackSecret !== undefined) {
    data.previousStatusCallbackSecret = integration.statusCallbackSecret;
    data.statusCallbackSecret = params.statusCallbackSecret === null ? null : encryptOrderSecret(params.statusCallbackSecret);
  }
  const syncEnabled = params.storeSyncEnabled ?? integration.storeSyncEnabled;
  const finalUrl = params.statusCallbackUrl !== undefined ? parseOrderCallbackUrl(params.statusCallbackUrl) : integration.statusCallbackUrl;
  const hasCallbackSecret = oneTimeCallbackSecret != null || (params.statusCallbackSecret !== undefined
    ? params.statusCallbackSecret !== null && params.statusCallbackSecret.trim() !== ""
    : integration.statusCallbackSecret != null);
  if (syncEnabled && (!finalUrl || !hasCallbackSecret)) {
    throw new AppError("Store sync requires an HTTPS callback URL and callback secret", 400);
  }
  if (Object.keys(data).length === 0) throw new AppError("At least one integration field is required", 400);
  const record = await updateOrderIntegration({
    id: params.integrationId,
    businessProfileId: integration.businessProfileId,
    data: data as any,
  });
  return {
    ok: true as const,
    integration: safeOrderIntegration(record),
    ...(oneTimeCallbackSecret ? { statusCallbackSecret: oneTimeCallbackSecret } : {}),
  };
}

export async function copilotRotateOrderIntegrationSecret(params: { userId: number; integrationId: number }) {
  const { integration } = await ownedOrderIntegration(params.userId, params.integrationId);
  const secret = generateRandomToken();
  const record = await rotateOrderIntegrationSecret({
    id: integration.id,
    businessProfileId: integration.businessProfileId,
    signingSecret: encryptOrderSecret(secret),
    previousSigningSecret: integration.signingSecret,
  });
  return { ok: true as const, integration: safeOrderIntegration(record), secret };
}

export async function copilotListApprovedOrderTemplates(params: { userId: number; whatsappAccountId: number }) {
  const { templates } = await approvedTemplatesForAccount(params.userId, params.whatsappAccountId);
  return { templates: templates.map(safeMetaTemplate) };
}

export async function copilotListOrderTemplateConfigs(params: { userId: number; integrationId: number; locale?: string }) {
  const { profileIds, integration } = await ownedOrderIntegration(params.userId, params.integrationId);
  if (!integration.whatsappAccountId) throw new AppError("Select a WhatsApp account before configuring templates", 400);
  const configs = await listOrderTemplateConfigs({
    profileIds,
    integrationId: integration.id,
    businessProfileId: integration.businessProfileId,
    whatsappAccountId: integration.whatsappAccountId,
    eventType: ORDER_EVENT_TYPE,
    ...(params.locale ? { locale: assertOrderLocale(params.locale) } : {}),
  });
  return { configs };
}

async function resolveOrderTemplate(params: {
  userId: number; integrationId: number; templateName: string; languageCode: string; variableMapping: unknown;
}) {
  const { integration } = await ownedOrderIntegration(params.userId, params.integrationId);
  if (!integration.whatsappAccountId) throw new AppError("Select a WhatsApp account before configuring templates", 400);
  const { templates } = await approvedTemplatesForAccount(params.userId, integration.whatsappAccountId);
  const template = templates.find((item) => item?.name === params.templateName && templateLanguage(item) === params.languageCode);
  if (!template) throw new AppError("Selected WhatsApp template is not currently approved", 400);
  return { integration, mapping: requireQuickReplyTemplate(template, params.variableMapping) };
}

export async function copilotCreateOrderTemplateConfig(params: {
  userId: number; integrationId: number; locale: string; templateName: string;
  languageCode: string; variableMapping: unknown; templateVersion?: number; isActive?: boolean;
}) {
  const { integration, mapping } = await resolveOrderTemplate(params);
  const record = await createOrderTemplateConfig({
    integrationId: integration.id,
    businessProfileId: integration.businessProfileId,
    whatsappAccountId: integration.whatsappAccountId!,
    eventType: ORDER_EVENT_TYPE,
    locale: assertOrderLocale(params.locale),
    templateName: params.templateName,
    languageCode: params.languageCode,
    templateVersion: params.templateVersion ?? 1,
    variableMapping: mapping as any,
    approvalStatus: "APPROVED",
    isActive: params.isActive ?? true,
  });
  return { ok: true as const, config: record };
}

export async function copilotUpdateOrderTemplateConfig(params: {
  userId: number; integrationId: number; configId: number; locale?: string; templateName?: string;
  languageCode?: string; variableMapping?: unknown; templateVersion?: number; isActive?: boolean;
}) {
  const { profileIds, integration } = await ownedOrderIntegration(params.userId, params.integrationId);
  if (!integration.whatsappAccountId) throw new AppError("Select a WhatsApp account before configuring templates", 400);
  const current = await findOrderTemplateConfigByIdForProfiles(params.configId, profileIds, integration.id);
  if (!current || current.businessProfileId !== integration.businessProfileId) throw new AppError("Order template configuration not found", 404);
  const finalName = params.templateName ?? current.templateName;
  const finalLanguage = params.languageCode ?? current.languageCode;
  const finalMapping = params.variableMapping ?? current.variableMapping;
  const finalActive = params.isActive ?? current.isActive;
  let mapping = finalMapping as OrderTemplateMapping;
  if (finalActive || params.templateName !== undefined || params.languageCode !== undefined || params.variableMapping !== undefined) {
    mapping = (await resolveOrderTemplate({
      userId: params.userId,
      integrationId: params.integrationId,
      templateName: finalName,
      languageCode: finalLanguage,
      variableMapping: finalMapping,
    })).mapping;
  }
  const locale = params.locale ? assertOrderLocale(params.locale) : current.locale;
  const data: Record<string, unknown> = {};
  if (params.locale !== undefined) data.locale = locale;
  if (params.templateName !== undefined) data.templateName = finalName;
  if (params.languageCode !== undefined) data.languageCode = finalLanguage;
  if (params.variableMapping !== undefined || finalActive) data.variableMapping = mapping as any;
  if (params.templateVersion !== undefined) data.templateVersion = params.templateVersion;
  if (params.isActive !== undefined) data.isActive = params.isActive;
  if (finalActive) data.approvalStatus = "APPROVED";
  if (Object.keys(data).length === 0) throw new AppError("At least one template field is required", 400);
  const record = await updateOrderTemplateConfig({
    id: current.id,
    integrationId: integration.id,
    businessProfileId: integration.businessProfileId,
    whatsappAccountId: integration.whatsappAccountId,
    data: data as any,
    ...(finalActive ? { activateKey: { whatsappAccountId: integration.whatsappAccountId, eventType: current.eventType, locale } } : {}),
  });
  return { ok: true as const, config: record };
}

export async function copilotPreviewOrderConfirmation(params: {
  userId: number; integrationId: number; event: unknown; locale?: string; templateConfigId?: number;
}) {
  const { integration } = await ownedOrderIntegration(params.userId, params.integrationId);
  if (!integration.whatsappAccountId) throw new AppError("Select a WhatsApp account before previewing", 400);
  let event;
  try {
    event = normalizeCanonicalOrderEvent(params.event);
  } catch (error) {
    throw new AppError(error instanceof Error ? error.message : "Invalid canonical order event", 400);
  }
  const locale = assertOrderLocale(params.locale ?? event.order.customer.locale ?? integration.defaultLocale);
  const config = await findOrderTemplateConfigForTest({
    id: params.templateConfigId,
    integrationId: integration.id,
    businessProfileId: integration.businessProfileId,
    whatsappAccountId: integration.whatsappAccountId,
    eventType: ORDER_EVENT_TYPE,
    locale,
  });
  if (!config || !config.isActive || config.approvalStatus !== "APPROVED") throw new AppError("No active approved template is configured for this locale", 404);
  const rendered = renderOrderTemplateVariables(
    event.order,
    validateOrderTemplateMapping(config.variableMapping, true),
    { confirm: "preview-confirm", cancel: "preview-cancel" },
    locale,
  );
  return { preview: { templateConfigId: config.id, templateName: config.templateName, languageCode: config.languageCode, locale, ...rendered } };
}

export async function copilotListWhatsAppSuppressions(params: { userId: number; businessProfileId?: number; activeOnly?: boolean }) {
  const profileIds = await getAccessibleProfileIds(params.userId);
  if (params.businessProfileId !== undefined && !profileIds.includes(params.businessProfileId)) throw new AppError("Business profile not found", 404);
  const rows = await prisma.whatsAppSuppression.findMany({
    where: {
      businessProfileId: params.businessProfileId ?? { in: profileIds },
      ...(params.activeOnly === false ? {} : { clearedAt: null }),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return { suppressions: rows.map((row) => ({ ...row, normalizedPhone: row.normalizedPhone.length <= 5 ? "***" : `${row.normalizedPhone.slice(0, 3)}***${row.normalizedPhone.slice(-2)}` })) };
}

export async function copilotClearWhatsAppSuppression(params: { userId: number; suppressionId: number }) {
  const profileIds = await getAccessibleProfileIds(params.userId);
  const result = await prisma.whatsAppSuppression.updateMany({
    where: { id: params.suppressionId, businessProfileId: { in: profileIds }, clearedAt: null },
    data: { clearedAt: new Date() },
  });
  if (result.count === 0) throw new AppError("Active WhatsApp suppression not found", 404);
  return { ok: true as const, suppressionId: params.suppressionId, cleared: true as const };
}

export async function copilotRetryOrderNotification(params: { userId: number; notificationId: number }) {
  const profileIds = await getAccessibleProfileIds(params.userId);
  const notification = await findNotificationForManagementRetry(params.notificationId, profileIds);
  if (!notification) throw new AppError("Order notification not found", 404);
  if (notification.status !== "FAILED") {
    throw new AppError("Only failed notifications can be retried", 409);
  }
  if (
    (notification.kind === "CONFIRMATION_REQUEST" && notification.order.status !== "AWAITING_CONFIRMATION") ||
    (notification.kind === "ACKNOWLEDGEMENT" && notification.order.status === "AWAITING_CONFIRMATION")
  ) {
    throw new AppError("This notification is no longer eligible for retry", 409);
  }
  const queued = await requeueNotificationForRetry(notification.id, notification.businessProfileId);
  if (!queued) throw new AppError("Notification retry was already claimed", 409);
  await enqueueNotificationRetry(notification.id, `management-notification-retry-${notification.id}`);
  return { ok: true as const, queued: true as const, notificationId: notification.id };
}

export async function copilotRetryOrderSync(params: { userId: number; syncId: number }) {
  const profileIds = await getAccessibleProfileIds(params.userId);
  const sync = await findStoreSyncForManagementRetry(params.syncId, profileIds);
  if (!sync) throw new AppError("Order store sync not found", 404);
  if (sync.status !== "FAILED") {
    throw new AppError("Only failed store synchronizations can be retried", 409);
  }
  if (sync.order.status !== sync.requestedStatus) {
    throw new AppError("This store synchronization is no longer eligible for retry", 409);
  }
  const queued = await requeueStoreSyncForRetry(sync.id, sync.businessProfileId);
  if (!queued) throw new AppError("Store synchronization retry was already claimed", 409);
  await enqueueStoreSyncRetry(sync.id, `management-store-sync-retry-${sync.id}`);
  return { ok: true as const, queued: true as const, syncId: sync.id };
}

// ---------------------------------------------------------------------------
// Copilot channel tools (WhatsApp accounts / Facebook pages / web widgets).
// Inline-prisma patterns cloned from whatsapp.controller / facebook.controller /
// widget.routes — every mutation re-checks ownership first.
// ---------------------------------------------------------------------------

const WHATSAPP_ACCOUNT_SELECT = {
  id: true,
  phoneNumberId: true,
  displayPhoneNumber: true,
  wabaId: true,
  businessProfileId: true,
  connectionMode: true,
  isActive: true,
  isTokenValid: true,
  createdAt: true,
  updatedAt: true,
} as const;

function sanitiseAccount(account: any) {
  if (!account) return account;
  const { accessToken: _omit, ...safe } = account;
  return safe;
}

export async function copilotListWhatsAppAccounts(params: {
  userId: number; businessProfileId: number;
}) {
  const access = await requireWorkspaceProfileAccess(params.userId, params.businessProfileId);
  const canManage = WORKSPACE_MANAGER_ROLES.includes(access.role as "owner" | "admin");
  const accounts = await prisma.whatsAppAccount.findMany({
    where: {
      isActive: true,
      OR: [
        { businessProfileId: params.businessProfileId },
        ...(canManage ? [{ userId: params.userId, businessProfileId: null }] : []),
      ],
    },
    select: WHATSAPP_ACCOUNT_SELECT,
  });
  return { accounts };
}

export async function copilotWhatsAppAccountAction(params: {
  userId: number; accountId: number; action: string; businessProfileId?: number;
}) {
  if (!params.businessProfileId) throw new AppError("businessProfileId is required", 400);
  await requireWorkspaceProfileAccess(params.userId, params.businessProfileId, { manage: true });
  const account = await prisma.whatsAppAccount.findFirst({
    where: {
      id: params.accountId,
      isActive: true,
      ...(params.action === "link"
        ? { userId: params.userId, OR: [{ businessProfileId: null }, { businessProfileId: params.businessProfileId }] }
        : { businessProfileId: params.businessProfileId }),
    },
  });
  if (!account) throw new AppError("WhatsApp account not found", 404);

  if (params.action === "link") {
    const updated = await prisma.whatsAppAccount.update({
      where: { id: account.id },
      data: { businessProfileId: params.businessProfileId },
    });
    await invalidateWhatsAppAccountCache(account.phoneNumberId).catch(() => {});
    return { ok: true as const, account: sanitiseAccount(updated) };
  }

  if (params.action === "unlink") {
    const updated = await prisma.whatsAppAccount.update({
      where: { id: account.id },
      data: { businessProfileId: null },
    });
    await invalidateWhatsAppAccountCache(account.phoneNumberId).catch(() => {});
    return { ok: true as const, account: sanitiseAccount(updated) };
  }

  if (params.action === "deactivate") {
    if (account.wabaId && account.accessToken) {
      try {
        const token = decryptFacebookSecret(account.accessToken);
        await unsubscribeWebhook(account.wabaId, token);
      } catch (err: any) {
        // Best-effort Meta unsubscribe — local deactivation still proceeds.
      }
    }
    await prisma.whatsAppAccount.update({
      where: { id: account.id },
      data: { isActive: false },
    });
    await invalidateWhatsAppAccountCache(account.phoneNumberId).catch(() => {});
    return { ok: true as const, message: "Account deactivated successfully" };
  }

  if (params.action === "resubscribe") {
    if (!account.wabaId || !account.accessToken) {
      throw new AppError("Account has no WABA ID or access token", 400);
    }
    const accessToken = decryptFacebookSecret(account.accessToken);
    await subscribeWebhook(account.wabaId, accessToken);
    return { ok: true as const, message: "Webhook re-subscribed successfully" };
  }

  throw new AppError("invalid_action", 400);
}

const FACEBOOK_PAGE_SELECT = {
  pageId: true,
  pageName: true,
  businessProfileId: true,
  isActive: true,
  commentAutoDmEnabled: true,
  commentPublicGreeting: true,
  updatedAt: true,
} as const;

export async function copilotListFacebookPages(params: {
  userId: number; businessProfileId: number;
}) {
  const access = await requireWorkspaceProfileAccess(params.userId, params.businessProfileId);
  const canManage = WORKSPACE_MANAGER_ROLES.includes(access.role as "owner" | "admin");
  const pages = await prisma.facebookPage.findMany({
    where: {
      isActive: true,
      OR: [
        { businessProfileId: params.businessProfileId },
        ...(canManage
          ? [{ facebookAccount: { userId: params.userId }, businessProfileId: null }]
          : []),
      ],
    },
    select: FACEBOOK_PAGE_SELECT,
    orderBy: { updatedAt: "desc" },
  });
  return { pages };
}

export async function copilotFacebookPageAction(params: {
  userId: number; pageId: string; action: string;
  businessProfileId?: number; commentAutoDmEnabled?: boolean; commentPublicGreeting?: string;
}) {
  if (!params.businessProfileId) throw new AppError("businessProfileId is required", 400);
  await requireWorkspaceProfileAccess(params.userId, params.businessProfileId, { manage: true });
  const page = await prisma.facebookPage.findFirst({
    where: {
      pageId: params.pageId,
      isActive: true,
      ...(params.action === "link"
        ? {
            facebookAccount: { userId: params.userId },
            OR: [{ businessProfileId: null }, { businessProfileId: params.businessProfileId }],
          }
        : { businessProfileId: params.businessProfileId }),
    },
    orderBy: { updatedAt: "desc" },
  });
  if (!page) throw new AppError("Page not found", 404);

  if (params.action === "link") {
    const updated = await prisma.facebookPage.update({
      where: { id: page.id },
      data: { businessProfileId: params.businessProfileId },
    });
    await Promise.all([
      invalidateFacebookPageCache(page.pageId).catch(() => {}),
      invalidateIdentityCache("messenger", page.pageId).catch(() => {}),
    ]);
    return { ok: true as const, page: updated };
  }

  if (params.action === "unlink") {
    if (!page.businessProfileId) return { ok: true as const, page };
    const updated = await prisma.facebookPage.update({
      where: { id: page.id },
      data: { businessProfileId: null },
    });
    await Promise.all([
      invalidateFacebookPageCache(page.pageId).catch(() => {}),
      invalidateIdentityCache("messenger", page.pageId).catch(() => {}),
    ]);
    return { ok: true as const, page: updated };
  }

  if (params.action === "settings") {
    const updated = await prisma.facebookPage.update({
      where: { id: page.id },
      data: {
        commentAutoDmEnabled:
          params.commentAutoDmEnabled !== undefined ? params.commentAutoDmEnabled : page.commentAutoDmEnabled,
        commentPublicGreeting:
          params.commentPublicGreeting !== undefined ? params.commentPublicGreeting : page.commentPublicGreeting,
      },
    });
    if (params.commentAutoDmEnabled !== undefined) {
      await prisma.user.updateMany({
        where: { id: params.userId, setupAgentConfiguredAt: null },
        data: { setupAgentConfiguredAt: new Date() },
      });
    }
    await invalidateIdentityCache("messenger", page.pageId).catch(() => {});
    return { ok: true as const, page: updated };
  }

  throw new AppError("invalid_action", 400);
}

function newPublicSiteKey(): string {
  return `wsk_${randomBytes(24).toString("base64url")}`;
}

async function findOwnedWidgetInstall(userId: number, installId: number) {
  const install = await prisma.widgetInstall.findFirst({
    where: { id: installId, userId },
  });
  if (!install) throw new AppError("Install not found", 404);
  return install;
}

export async function copilotListWidgetInstalls(userId: number, businessProfileId?: number) {
  const installs = await prisma.widgetInstall.findMany({
    where: {
      userId,
      ...(businessProfileId
        ? { businessProfileId }
        : {}),
    },
    orderBy: { createdAt: "desc" },
  });
  return { installs };
}

export async function copilotWidgetAction(params: {
  userId: number; action: string; installId?: number;
  allowedOrigins?: string[]; isActive?: boolean; businessProfileId?: number;
}) {
  if (params.action === "create") {
    if (!params.businessProfileId) throw new AppError("businessProfileId is required", 400);
    const authorized = await prisma.businessProfile.findFirst({
      where: { id: params.businessProfileId, userId: params.userId },
    });
    if (!authorized) throw new AppError("Business profile not found", 404);
    const origins = parseAllowedOrigins(params.allowedOrigins);
    if (origins.length === 0) {
      throw new AppError("allowedOrigins must be a non-empty array of origin strings", 400);
    }
    const install = await prisma.widgetInstall.create({
      data: {
        userId: params.userId,
        businessProfileId: params.businessProfileId,
        publicSiteKey: newPublicSiteKey(),
        identitySecret: generateIdentitySecret(),
        allowedOrigins: origins,
        settings: undefined,
      },
    });
    return { ok: true as const, install };
  }

  if (!params.installId) throw new AppError("installId is required", 400);
  const install = await findOwnedWidgetInstall(params.userId, params.installId);

  if (params.action === "update") {
    const data: Record<string, unknown> = {};
    if (params.businessProfileId !== undefined) {
      const authorized = await prisma.businessProfile.findFirst({
        where: { id: params.businessProfileId, userId: params.userId },
      });
      if (!authorized) throw new AppError("Business profile not found", 404);
      data.businessProfileId = params.businessProfileId;
    }
    if (params.allowedOrigins !== undefined) {
      const origins = parseAllowedOrigins(params.allowedOrigins);
      if (origins.length === 0) {
        throw new AppError("allowedOrigins must be a non-empty array when provided", 400);
      }
      data.allowedOrigins = origins;
    }
    if (params.isActive !== undefined) {
      data.isActive = Boolean(params.isActive);
    }
    const updated = await prisma.widgetInstall.update({ where: { id: install.id }, data: data as any });
    return { ok: true as const, install: updated };
  }

  if (params.action === "deactivate") {
    await prisma.widgetInstall.update({
      where: { id: install.id },
      data: { isActive: false },
    });
    return { ok: true as const };
  }

  if (params.action === "delete") {
    await prisma.widgetInstall.delete({ where: { id: install.id } });
    return { ok: true as const };
  }

  if (params.action === "identity_secret") {
    const secret = await prisma.widgetInstall.findFirst({
      where: { id: install.id, userId: params.userId },
      select: { identitySecret: true },
    });
    return { ok: true as const, identitySecret: secret?.identitySecret };
  }

  throw new AppError("invalid_action", 400);
}

// ---------------------------------------------------------------------------
// Copilot account tool (update_account) — name/avatarUrl → user profile.
// ---------------------------------------------------------------------------

export async function copilotUpdateAccount(params: { userId: number; name?: string; avatarUrl?: string }) {
  const user = await updateCurrentUserProfile(params.userId, {
    ...(params.name !== undefined ? { name: params.name } : {}),
    ...(params.avatarUrl !== undefined ? { avatar: params.avatarUrl } : {}),
  });
  return { ok: true as const, user };
}
