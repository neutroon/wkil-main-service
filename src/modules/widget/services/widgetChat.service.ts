import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import {
  getOrCreateConversation,
  saveMessage,
} from "@modules/meta/core/conversation.service";
import { upsertCustomerFromConversation } from "@modules/business/customer/customer.service";
import { computeBusinessChatReply } from "@modules/ai-agent/chat/businessChatReply.service";
import { initialCustomerReplyStatus } from "@modules/ai-agent/chat/deliveryPolicy";
import {
  runSavedModelReplySideEffectsInBackground,
} from "@modules/ai-agent/chat/replySideEffects.service";
import { AiRoutingDecision } from "@modules/ai-agent/core/aiEngine.utils";
import { buildUnansweredUserTurnContext } from "@modules/ai-agent/chat/conversationTurnContext";
import {
  assertLatestConversationAiRun,
  isStaleConversationRunError,
  startConversationAiRun,
} from "@modules/ai-agent/chat/conversationRunGuard";
import type { WidgetInstall } from "@prisma/client";
import { AppError } from "@middlewares/errorHandler.middleware";
import { generateR2Key, uploadToR2 } from "@modules/media/services/r2Storage.service";
import { invokeMediaUnderstanding } from "@modules/ai-agent/core/modelRuntime";

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
}): Promise<{
  reply: string;
  conversationId: number;
  attachment?: { url: string; type: string; caption?: string | null } | null;
}> {
  const { install, message } = params;
  const { conversation, businessProfile, userMessage } =
    await setupWidgetChat(params);

  if (conversation.aiEnabled === false) {
    logger.info("widget.chat.automation_skip", {
      conversationId: conversation.id,
      reason: "AI_TOGGLE_OFF",
    });
    return {
      reply: "",
      conversationId: conversation.id,
    };
  }

  const run = await startConversationAiRun({
    conversationId: conversation.id,
    latestUserMessageId: userMessage.id,
  });
  const turnContext = await buildUnansweredUserTurnContext({
    conversationId: conversation.id,
    latestUserMessageId: userMessage.id,
  });

  let reply: AiRoutingDecision;
  try {
    reply = await computeBusinessChatReply({
      businessProfile,
      messageText: turnContext.messageText || message,
      historyTurns: turnContext.historyTurns,
      channel: "web",
      conversationId: conversation.id,
      conversationRunId: run.runId,
      latestUserMessageId: userMessage.id,
    });
    await assertLatestConversationAiRun(run, "after_widget_reply_compute");
  } catch (err: unknown) {
    if (isStaleConversationRunError(err)) {
      return {
        reply: "",
        conversationId: conversation.id,
      };
    }

    const msg = err instanceof Error ? err.message : String(err);
    logger.error("widget.chat.ai_failed", {
      widgetInstallId: install.id,
      conversationId: conversation.id,
      error: msg,
    });
    reply = {
      action: "HANDOFF_TO_HUMAN",
      handoffCategory: "SYSTEM_ERROR",
      reasoning: `Infrastructure Failure: ${msg}`,
      content: null,
    };
  }

  if (reply.action === "RESOLVE_CONVERSATION") {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { status: "RESOLVED" },
    });
    logger.info("widget.chat.conversation_resolved_by_ai", {
      conversationId: conversation.id,
    });
    return { reply: "", conversationId: conversation.id };
  }

  const status = initialCustomerReplyStatus(reply, "web");
  const replyContent = (reply.content || "").trim();

  if (reply.action === "REPLY_AUTO" && replyContent.length === 0 && !reply.attachment) {
    logger.info("widget.chat.empty_auto_reply_skipped", {
      widgetInstallId: install.id,
      conversationId: conversation.id,
      reasoning: reply.reasoning,
    });
    return {
      reply: "",
      conversationId: conversation.id,
    };
  }

  try {
    await assertLatestConversationAiRun(run, "before_widget_reply_save");
  } catch (err: unknown) {
    if (isStaleConversationRunError(err)) {
      return {
        reply: "",
        conversationId: conversation.id,
      };
    }
    throw err;
  }

  const botMsg = await saveMessage(
    conversation.id,
    "model",
    replyContent,
    {
      status,
      aiReasoning: reply.reasoning,
      handoffCategory: reply.handoffCategory,
    },
  );

  if (reply.handoffCategory === "SYSTEM_ERROR") {
    runSavedModelReplySideEffectsInBackground({
      businessProfileId: install.businessProfileId,
      conversationId: conversation.id,
      message: botMsg,
      reply,
    });
    return {
      reply: "",
      conversationId: conversation.id,
    };
  }

  runSavedModelReplySideEffectsInBackground({
    businessProfileId: install.businessProfileId,
    conversationId: conversation.id,
    message: botMsg,
    reply,
    scheduleFollowUps: true,
  });

  {
    logger.info("widget.chat.reply_sent", {
      widgetInstallId: install.id,
      conversationId: conversation.id,
      preview: (reply.content || "").substring(0, 80),
    });

    // Resolve attachment for web delivery if AI included one
    let attachmentForWidget: {
      url: string;
      type: string;
      caption?: string | null;
    } | null = null;
    if (reply.attachment?.assetName) {
      const { resolveAssetForChannel } =
        await import("@modules/media/services/mediaLibrary.service");
      const resolved = await resolveAssetForChannel(
        reply.attachment.assetName,
        install.businessProfileId,
        "web",
      );
      if (resolved?.url) {
        attachmentForWidget = {
          url: resolved.url,
          type: resolved.mediaType,
          caption: reply.attachment.caption ?? null,
        };
        await saveMessage(
          conversation.id,
          "model",
          reply.attachment.caption ?? "",
          {
            type: resolved.mediaType,
            status: "SENT",
            mediaMetadata: { url: resolved.url },
          },
        );
      }
    }

    return {
      reply: reply.content || "",
      conversationId: conversation.id,
      attachment: attachmentForWidget,
    };
  }
}

/**
 * Common setup logic for widget chat.
 */
async function setupWidgetChat(params: {
  install: WidgetInstall;
  visitorId: string;
  message: string;
  conversationId?: number;
  media?: WidgetInboundMedia;
}) {
  const { install, visitorId, message, conversationId, media } = params;
  const pageId = pageIdForWidget(install.id);

  let conversation;
  // Treat null as undefined to trigger auto-discovery
  const effectiveConversationId =
    conversationId === null ? undefined : conversationId;

  if (effectiveConversationId !== undefined) {
    const verified = await prisma.conversation.findFirst({
      where: { id: effectiveConversationId, pageId, senderId: visitorId },
    });
    if (!verified)
      throw new AppError("Invalid conversationId for this visitor", 400);
    conversation = verified;
    if (!conversation.customerId) {
      const customer = await upsertCustomerFromConversation({
        businessProfileId: install.businessProfileId,
        conversationId: conversation.id,
        channel: "web",
        senderId: visitorId,
      });
      conversation = { ...conversation, customerId: customer.id };
    }
  } else {
    conversation = await getOrCreateConversation(
      pageId,
      visitorId,
      install.businessProfileId,
      { channel: "web" },
    );
  }

  const businessProfile = await prisma.businessProfile.findUniqueOrThrow({
    where: { id: install.businessProfileId },
    include: {
      agentActionSources: { where: { isActive: true } },
    },
  });

  const mediaPayload = media
    ? await prepareWidgetMediaPayload({
        businessProfileId: install.businessProfileId,
        media,
      })
    : null;
  const userMessage = await saveMessage(conversation.id, "user", message, {
    type: mediaPayload?.type,
    mediaId: mediaPayload?.mediaId,
    mediaMetadata: mediaPayload?.mediaMetadata,
  });

  return { conversation, businessProfile, userMessage };
}

async function prepareWidgetMediaPayload(params: {
  businessProfileId: number;
  media: WidgetInboundMedia;
}) {
  const type = mediaTypeFromMime(params.media.mimeType);
  const key = generateR2Key(params.businessProfileId, params.media.originalName);
  const url = await uploadToR2(key, params.media.buffer, params.media.mimeType);
  const analysis = await understandWidgetMedia(params.media);

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
  if (!media.mimeType.startsWith("image/")) {
    return {
      status: "unsupported",
      mimeType: media.mimeType,
      errorCode: "unsupported_media_type",
    };
  }

  try {
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
