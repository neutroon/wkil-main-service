import { AgentClient } from "@modules/ai-agent/client/agent.client";
import prisma from "@config/prisma";
import {
  finalizeCustomerTurn,
  prepareCustomerTurn,
  type CustomerTurnHandle,
  type CustomerTurnParams,
} from "@modules/ai-agent/customer/customerAgent.service";
import { applyCustomerDecision } from "@modules/ai-agent/customer/customerDecision.service";
import {
  customerAgentDecisionSchema,
} from "@modules/ai-agent/customer/customerAgent.types";
import {
  getOrCreateConversation,
  saveMessage,
} from "@modules/meta/core/conversation.service";
import { upsertCustomerFromConversation } from "@modules/business/customer/customer.service";
import type { WidgetInstall } from "@prisma/client";
import { AppError } from "@middlewares/errorHandler.middleware";
import {
  generateR2Key,
  uploadToR2,
} from "@modules/media/services/r2Storage.service";
import { createLatencyTrace, type LatencyTrace } from "@utils/latencyTrace";
import {
  syncVerifiedUserProfile,
  type VerifiedWidgetUser,
} from "@modules/widget/services/widgetIdentity.service";

function pageIdForWidget(installId: number): string {
  return `widget:${installId}`;
}

type WidgetInboundMedia = {
  buffer: Buffer;
  originalName: string;
  mimeType: string;
  size: number;
};

export type WidgetChatResult = {
  reply: string;
  conversationId: number;
  action: "REPLY" | "HANDOFF" | "RESOLVE" | "NO_REPLY";
  attachment: { url: string; type: string; caption?: string | null } | null;
};

type WidgetChatParams = {
  install: WidgetInstall;
  visitorId: string;
  message: string;
  conversationId?: number;
  media?: WidgetInboundMedia;
  verifiedUser?: VerifiedWidgetUser;
};

export type PreparedWidgetChat =
  | { result: WidgetChatResult; handle?: never; turnParams?: never; businessProfileId?: never; conversationId?: never }
  | {
    result?: never;
    handle: CustomerTurnHandle;
    turnParams: CustomerTurnParams;
    businessProfileId: number;
    conversationId: number;
  };

/**
 * Persists the public inbound message, then prepares its durable customer-agent
 * turn. Streaming callers use the returned exact run handle instead of
 * creating a second stateless capability invocation.
 */
export async function prepareWidgetChatMessage(
  params: WidgetChatParams,
  signal?: AbortSignal,
): Promise<PreparedWidgetChat> {
  const prepared = await setupWidgetChat(params, createLatencyTrace());
  if (prepared.conversation.aiEnabled === false) {
    return {
      result: {
        reply: "",
        conversationId: prepared.conversation.id,
        action: "NO_REPLY",
        attachment: null,
      },
    };
  }
  const turnParams: CustomerTurnParams = {
    userId: prepared.businessProfile.userId,
    businessProfileId: prepared.businessProfile.id,
    conversationId: prepared.conversation.id,
    channel: "web",
    inputMessageId: prepared.userMessage.id,
    customerText: params.message,
    runMode: "inbound",
    // The durable coordinator namespaces this local message identity by
    // tenant, conversation, and web channel before persisting it.
    dedupeKey: `message:${prepared.userMessage.id}`,
    mediaContext: widgetMediaContext(prepared.userMessage),
    signal,
  };
  const handle = await prepareCustomerTurn(turnParams);
  return {
    handle,
    turnParams,
    businessProfileId: prepared.businessProfile.id,
    conversationId: prepared.conversation.id,
  };
}

export async function processWidgetChatMessage(
  params: WidgetChatParams,
): Promise<WidgetChatResult> {
  const prepared = await prepareWidgetChatMessage(params);
  if (prepared.result) return prepared.result;
  try {
    const decision = await AgentClient.joinCustomerRun(
      prepared.handle.threadId,
      prepared.handle.runId,
    );
    return completeWidgetChatMessage(prepared, decision);
  } catch (error) {
    await failWidgetChatMessage(prepared, error);
    throw error;
  }
}

/** Completes the prepared turn from an already-observed Agent Server decision. */
export async function completeWidgetChatMessage(
  prepared: Exclude<PreparedWidgetChat, { result: WidgetChatResult }>,
  rawDecision: unknown,
): Promise<WidgetChatResult> {
  const decision = customerAgentDecisionSchema.parse(rawDecision);
  await finalizeCustomerTurn(prepared.turnParams, prepared.handle);
  await prisma.agentTurn.update({
    where: { id: prepared.handle.agentTurnId },
    data: { decision, status: "COMPLETED", failureReason: null },
  });

  let attachment: WidgetChatResult["attachment"] = null;
  const applied = await applyCustomerDecision({
    businessProfileId: prepared.businessProfileId,
    conversationId: prepared.conversationId,
    agentTurnId: prepared.handle.agentTurnId,
    decision,
    deliver: async (message) => {
      attachment = await resolveWidgetAttachment(rawDecision, prepared.businessProfileId);
      return { externalId: `widget:${message.id}` };
    },
  });
  if (applied.action === "REPLY" && !attachment) {
    attachment = await resolveWidgetAttachment(rawDecision, prepared.businessProfileId);
  }
  return {
    reply: applied.action === "REPLY" ? applied.message.content : "",
    conversationId: prepared.conversationId,
    action: applied.action,
    attachment,
  };
}

/**
 * Release/complete the coordinator's history claim even when the stream is
 * interrupted, then leave only a redacted durable failure classification.
 */
export async function failWidgetChatMessage(
  prepared: Exclude<PreparedWidgetChat, { result: WidgetChatResult }>,
  error: unknown,
): Promise<void> {
  try {
    await finalizeCustomerTurn(prepared.turnParams, prepared.handle);
  } finally {
    await prisma.agentTurn.update({
      where: { id: prepared.handle.agentTurnId },
      data: { status: "FAILED", failureReason: widgetTurnFailureCode(error) },
    });
  }
}

function widgetMediaContext(message: { mediaMetadata?: unknown }): string | null {
  if (message.mediaMetadata == null) return null;
  try {
    return JSON.stringify(message.mediaMetadata);
  } catch {
    return null;
  }
}

async function resolveWidgetAttachment(
  rawDecision: unknown,
  businessProfileId: number,
): Promise<WidgetChatResult["attachment"]> {
  const attachment = isRecord(rawDecision) && isRecord(rawDecision.attachment)
    ? rawDecision.attachment
    : null;
  const assetName = attachment && typeof attachment.asset_name === "string"
    ? attachment.asset_name.trim()
    : "";
  if (!assetName) return null;
  const { resolveAssetForChannel } = await import("@modules/media/services/mediaLibrary.service");
  const resolved = await resolveAssetForChannel(assetName, businessProfileId, "web");
  if (!resolved?.url) return null;
  return {
    url: resolved.url,
    type: resolved.mediaType,
    caption: typeof attachment?.caption === "string" ? attachment.caption : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function widgetTurnFailureCode(error: unknown): string {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
  if (code === "CUSTOMER_AGENT_RUN_ABORTED") return code;
  if (error instanceof Error && /timeout/i.test(error.message)) return "CUSTOMER_AGENT_TIMEOUT";
  return "CUSTOMER_AGENT_FAILURE";
}

/**
 * Common setup logic for widget chat.
 */
async function setupWidgetChat(
  params: {
    install: WidgetInstall;
    visitorId: string;
    message: string;
    conversationId?: number;
    media?: WidgetInboundMedia;
    verifiedUser?: VerifiedWidgetUser;
  },
  latency: LatencyTrace,
) {
  const { install, visitorId, message, conversationId, media, verifiedUser } =
    params;
  const pageId = pageIdForWidget(install.id);

  let conversation: any;
  const effectiveConversationId =
    conversationId === null ? undefined : conversationId;

  if (effectiveConversationId !== undefined) {
    const verified = await latency.measure("conversationSetupMs", () =>
      prisma.conversation.findFirst({
        where: { id: effectiveConversationId, pageId, senderId: visitorId },
      }),
    );
    if (!verified)
      throw new AppError("Invalid conversationId for this visitor", 400);
    conversation = verified;
    if (!conversation.customerId) {
      const customer = await latency.measure("conversationSetupMs", () =>
        upsertCustomerFromConversation({
          businessProfileId: install.businessProfileId,
          conversationId: conversation.id,
          channel: "web",
          senderId: visitorId,
          customerName: verifiedUser?.name,
          customerPhone: verifiedUser?.phone,
          customerAvatar: verifiedUser?.avatar,
        }),
      );
      conversation = { ...conversation, customerId: customer.id };
    }
    if (verifiedUser && conversation.customerId) {
      await syncVerifiedUserProfile(conversation.customerId, verifiedUser);
    }
    // Always refresh conversation-level customer fields from verified data
    if (verifiedUser) {
      const convUpdate: Record<string, string> = {};
      if (verifiedUser.name) convUpdate.customerName = verifiedUser.name;
      if (verifiedUser.phone) convUpdate.customerPhone = verifiedUser.phone;
      if (verifiedUser.avatar) convUpdate.customerAvatar = verifiedUser.avatar;
      if (Object.keys(convUpdate).length > 0) {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: convUpdate,
        });
        conversation = { ...conversation, ...convUpdate };
      }
    }
  } else {
    conversation = await latency.measure("conversationSetupMs", () =>
      getOrCreateConversation(pageId, visitorId, install.businessProfileId, {
        channel: "web",
        customerName: verifiedUser?.name,
        customerPhone: verifiedUser?.phone,
        customerAvatar: verifiedUser?.avatar,
      }),
    );

    if (verifiedUser && conversation.customerId) {
      await syncVerifiedUserProfile(conversation.customerId, verifiedUser);
    }
    // Always refresh conversation-level customer fields from verified data
    if (verifiedUser) {
      const convUpdate: Record<string, string> = {};
      if (verifiedUser.name) convUpdate.customerName = verifiedUser.name;
      if (verifiedUser.phone) convUpdate.customerPhone = verifiedUser.phone;
      if (verifiedUser.avatar) convUpdate.customerAvatar = verifiedUser.avatar;
      if (Object.keys(convUpdate).length > 0) {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: convUpdate,
        });
        conversation = { ...conversation, ...convUpdate };
      }
    }
  }

  const businessProfile = await latency.measure("businessProfileMs", () =>
    prisma.businessProfile.findUniqueOrThrow({
      where: { id: install.businessProfileId },
      include: {
        agentActionSources: { where: { isActive: true } },
      },
    }),
  );

  const mediaPayload = media
      ? await prepareWidgetMediaPayload({
        businessProfileId: install.businessProfileId,
        userId: businessProfile.userId,
        media,
        latency,
      })
    : null;
  const userMessage = await latency.measureDb("saveInboundMs", () =>
    saveMessage(conversation.id, "user", message, {
      type: mediaPayload?.type,
      mediaId: mediaPayload?.mediaId,
      mediaMetadata: mediaPayload?.mediaMetadata,
    }),
  );

  return { conversation, businessProfile, userMessage };
}

async function prepareWidgetMediaPayload(params: {
  businessProfileId: number;
  userId: number;
  media: WidgetInboundMedia;
  latency: LatencyTrace;
}) {
  const type = mediaTypeFromMime(params.media.mimeType);
  const key = generateR2Key(
    params.businessProfileId,
    params.media.originalName,
  );
  const url = await params.latency.measure("mediaUploadMs", () =>
    uploadToR2(key, params.media.buffer, params.media.mimeType),
  );
  const analysis = await params.latency.measure("mediaUnderstandingMs", () =>
    understandWidgetMedia(params.media, params.businessProfileId, params.userId),
  );

  return {
    type,
    mediaId: key,
    mediaMetadata: {
      url,
      r2Key: key,
      filename: params.media.originalName,
      mimeType: params.media.mimeType,
      size: params.media.size,
      analysis,
    },
  };
}

function mediaTypeFromMime(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

async function understandWidgetMedia(
  media: WidgetInboundMedia,
  businessProfileId: number,
  userId: number,
): Promise<Record<string, unknown>> {
  const isImage = media.mimeType.startsWith("image/");
  const isAudio = media.mimeType.startsWith("audio/");

  if (!isImage && !isAudio) {
    return {
      status: "unsupported",
      mimeType: media.mimeType,
      errorCode: "unsupported_media_type",
    };
  }

  try {
    if (isAudio) {
      // Inbound media understanding moved to the sibling agent-svc microservice
      // in the ai-agent cutover. The platform routes the request via AgentClient.
      const result = await AgentClient.runCapability({
        userId,
        businessProfileId,
        operation: "media_understanding",
        context: { mode: "audio", mimeType: media.mimeType, dataBase64: media.buffer.toString("base64") },
      });
      const transcript = String(result?.text || "").trim();
      return {
        status: transcript ? "completed" : "failed",
        text: transcript || undefined,
        transcript: transcript || undefined,
        mimeType: media.mimeType,
        modelName: undefined,
        finishReason: null,
        ...(transcript ? {} : { errorCode: "media_understanding_disabled" }),
      };
    }

    const result = await AgentClient.runCapability({
      userId,
      businessProfileId,
      operation: "media_understanding",
      context: { mode: "image", mimeType: media.mimeType, dataBase64: media.buffer.toString("base64") },
    });
    const text = String(result?.text || "").trim();
    return {
      status: text ? "completed" : "failed",
      text: text || undefined,
      mimeType: media.mimeType,
      modelName: undefined,
      finishReason: null,
      ...(text ? {} : { errorCode: "media_understanding_disabled" }),
    };
  } catch (error: unknown) {
    return {
      status: "failed",
      mimeType: media.mimeType,
      errorCode: error instanceof Error ? error.message : String(error),
    };
  }
}
