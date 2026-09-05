import { AgentClient } from "@modules/ai-agent/client/agent.client";
import prisma from "@config/prisma";
import { logger } from "@utils/logger";
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

export async function processWidgetChatMessage(params: {
  install: WidgetInstall;
  visitorId: string;
  message: string;
  conversationId?: number;
  media?: WidgetInboundMedia;
  verifiedUser?: VerifiedWidgetUser;
}): Promise<{
  reply: string;
  conversationId: number;
  attachment?: { url: string; type: string; caption?: string | null } | null;
}> {
  const prepared = await setupWidgetChat(params, createLatencyTrace());
  if (prepared.conversation.aiEnabled === false) {
    return { reply: "", conversationId: prepared.conversation.id };
  }
  const rows = await prisma.conversationMessage.findMany({
    where: { conversationId: prepared.conversation.id },
    orderBy: { createdAt: "asc" },
    take: 40,
    select: { role: true, content: true },
  });
  const result = await AgentClient.runCapability({
    userId: prepared.businessProfile.userId,
    businessProfileId: prepared.businessProfile.id,
    operation: "customer_reply",
    context: {
      channel: "web",
      messageText: params.message,
      business: prepared.businessProfile,
      historyTurns: rows.map((row) => ({
        role: row.role === "user" ? "customer" : "agent",
        content: row.content || "",
      })),
      mediaInfo: null,
      conversationId: prepared.conversation.id,
    },
  });
  if (result.action === "RESOLVE_CONVERSATION") {
    await prisma.conversation.update({
      where: { id: prepared.conversation.id }, data: { status: "RESOLVED" },
    });
    return { reply: "", conversationId: prepared.conversation.id };
  }
  const reply = (result.content || "").trim();
  if (reply) {
    await saveMessage(prepared.conversation.id, "model", reply, {
      status: "SENT",
      aiReasoning: result.reasoning,
      handoffCategory: result.handoff_category,
    });
  }
  let attachment: { url: string; type: string; caption?: string | null } | null = null;
  if (result.attachment?.asset_name) {
    const { resolveAssetForChannel } = await import("@modules/media/services/mediaLibrary.service");
    const resolved = await resolveAssetForChannel(
      result.attachment.asset_name, prepared.businessProfile.id, "web",
    );
    if (resolved?.url) {
      attachment = {
        url: resolved.url,
        type: resolved.mediaType,
        caption: result.attachment.caption ?? null,
      };
    }
  }
  return { reply, conversationId: prepared.conversation.id, attachment };
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
