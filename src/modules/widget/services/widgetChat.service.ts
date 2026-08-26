import { AgentClient } from "@modules/ai-agent/client/agent.client";
import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import {
  getOrCreateConversation,
  saveMessage,
} from "@modules/meta/core/conversation.service";
import { upsertCustomerFromConversation } from "@modules/business/customer/customer.service";
import { computeBusinessChatReply } from "@modules/ai-agent/chat/businessChatReply.service";
import { initialCustomerReplyStatus } from "@modules/ai-agent/chat/deliveryPolicy";
import { runSavedModelReplySideEffectsInBackground } from "@modules/ai-agent/chat/replySideEffects.service";
import { AiRoutingDecision } from "@modules/ai-agent/core/aiEngine.utils";
import { buildUnansweredUserTurnContext } from "@modules/ai-agent/chat/conversationTurnContext";
import {
  assertLatestConversationAiRun,
  isStaleConversationRunError,
  startConversationAiRun,
} from "@modules/ai-agent/chat/conversationRunGuard";
import type { WidgetInstall } from "@prisma/client";
import { AppError } from "@middlewares/errorHandler.middleware";
import {
  generateR2Key,
  uploadToR2,
} from "@modules/media/services/r2Storage.service";
import { invokeMediaUnderstanding } from "@modules/ai-agent/core/modelRuntime";
import { createLatencyTrace, type LatencyTrace } from "@utils/latencyTrace";
import {
  syncVerifiedUserEmail,
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
  return AgentClient.runAgent({
    business_profile_id: params.install.businessProfileId,
    user_id: undefined,
    messages: [],
    stage: "fast",
  } as any) as any;
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
    understandWidgetMedia(params.media),
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
      const result = await invokeMediaUnderstanding({
        prompt: [
          "Transcribe this customer voice message exactly as spoken.",
          "Return only the transcription text, nothing else.",
          "If the audio is unclear or contains no speech, return an empty response.",
        ].join("\n"),
        mimeType: media.mimeType,
        base64Data: media.buffer.toString("base64"),
        maxOutputTokens: 4096,
        timeoutMs: 30_000,
      });
      const transcript = result.text.trim();
      return {
        status: "completed",
        text: transcript,
        transcript,
        mimeType: media.mimeType,
        modelName: result.modelName,
        finishReason: result.finishReason,
      };
    }

    const result = await invokeMediaUnderstanding({
      prompt: [
        "Describe this customer-sent image for a customer support agent.",
        "Use one or two concise sentences.",
        "If the image contains readable text, include the important text.",
        "Do not invent prices, policies, availability, or contact details.",
      ].join("\n"),
      mimeType: media.mimeType,
      base64Data: media.buffer.toString("base64"),
      maxOutputTokens: 512,
      timeoutMs: 45_000,
    });
    return {
      status: "completed",
      text: result.text.trim(),
      mimeType: media.mimeType,
      modelName: result.modelName,
      finishReason: result.finishReason,
    };
  } catch (error: unknown) {
    return {
      status: "failed",
      mimeType: media.mimeType,
      errorCode: error instanceof Error ? error.message : String(error),
    };
  }
}
