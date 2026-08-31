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
import { sendWhatsAppReply } from "@modules/meta/whatsapp/whatsapp.service";
import { sendMessengerReply } from "@modules/meta/messenger/messenger.service";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
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
  listOrderIntegrations,
  findOrderIntegrationForProfiles,
  updateOrderIntegration,
  findNotificationForManagementRetry,
  requeueNotificationForRetry,
  findStoreSyncForManagementRetry,
  requeueStoreSyncForRetry,
} from "@modules/order-confirmation/orderConfirmation.repository";
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
  corePolicies: true, aiBehaviorInstructions: true,
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
  draft: Record<string, unknown>;
  documents?: { kind: string; title?: string; content: string }[];
}) {
  const profileId = await resolveProfileId(params.userId);
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

export async function copilotUpdateOrderIntegration(params: {
  userId: number; integrationId: number;
  isActive?: boolean; storeSyncEnabled?: boolean; defaultLocale?: string;
}) {
  const profileIds = await getAccessibleProfileIds(params.userId);
  const integration = await findOrderIntegrationForProfiles(params.integrationId, profileIds);
  if (!integration) throw new AppError("Order integration not found", 404);
  const data: Record<string, unknown> = {};
  if (params.isActive !== undefined) data.isActive = params.isActive;
  if (params.storeSyncEnabled !== undefined) data.storeSyncEnabled = params.storeSyncEnabled;
  if (params.defaultLocale !== undefined) data.defaultLocale = params.defaultLocale;
  const record = await updateOrderIntegration({
    id: params.integrationId,
    businessProfileId: integration.businessProfileId,
    data: data as any,
  });
  return { ok: true as const, integration: record };
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

async function findOwnedWhatsAppAccount(userId: number, accountId: number) {
  const account = await prisma.whatsAppAccount.findFirst({
    where: { id: accountId, userId, isActive: true },
  });
  if (!account) throw new AppError("WhatsApp account not found", 404);
  return account;
}

export async function copilotListWhatsAppAccounts(userId: number) {
  const accounts = await prisma.whatsAppAccount.findMany({
    where: { userId, isActive: true },
    select: WHATSAPP_ACCOUNT_SELECT,
  });
  return { accounts };
}

export async function copilotWhatsAppAccountAction(params: {
  userId: number; accountId: number; action: string; businessProfileId?: number;
}) {
  const account = await findOwnedWhatsAppAccount(params.userId, params.accountId);

  if (params.action === "link") {
    if (!params.businessProfileId) throw new AppError("businessProfileId is required", 400);
    const businessProfile = await prisma.businessProfile.findFirst({
      where: { id: params.businessProfileId, userId: params.userId },
    });
    if (!businessProfile) throw new AppError("Business profile not found", 404);
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

async function findOwnedFacebookPage(userId: number, pageId: string) {
  const page = await prisma.facebookPage.findFirst({
    where: { pageId, facebookAccount: { userId }, isActive: true },
    orderBy: { updatedAt: "desc" },
  });
  if (!page) throw new AppError("Page not found", 404);
  return page;
}

export async function copilotListFacebookPages(userId: number) {
  const pages = await prisma.facebookPage.findMany({
    where: { facebookAccount: { userId }, isActive: true },
    select: FACEBOOK_PAGE_SELECT,
    orderBy: { updatedAt: "desc" },
  });
  return { pages };
}

export async function copilotFacebookPageAction(params: {
  userId: number; pageId: string; action: string;
  businessProfileId?: number; commentAutoDmEnabled?: boolean; commentPublicGreeting?: string;
}) {
  const page = await findOwnedFacebookPage(params.userId, params.pageId);

  if (params.action === "link") {
    if (!params.businessProfileId) throw new AppError("businessProfileId is required", 400);
    const businessProfile = await prisma.businessProfile.findFirst({
      where: { id: params.businessProfileId, userId: params.userId },
    });
    if (!businessProfile) throw new AppError("Business profile not found", 404);
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

export async function copilotListWidgetInstalls(userId: number) {
  const installs = await prisma.widgetInstall.findMany({
    where: { userId },
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
