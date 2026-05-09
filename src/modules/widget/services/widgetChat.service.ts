import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import {
  getOrCreateConversation,
  getConversationHistory,
  saveMessage,
} from "@modules/meta/core/conversation.service";
import { computeBusinessChatReply } from "@modules/ai-agent/chat/businessChatReply.service";
import { AiRoutingDecision } from "@modules/ai-agent/core/aiEngine.utils";
import {
  historyToLlmTurns,
  toPromptMessages,
} from "@modules/ai-agent/chat/conversationTurns";
import type { WidgetInstall } from "@prisma/client";
import { AppError } from "@middlewares/errorHandler.middleware";

function pageIdForWidget(installId: number): string {
  return `widget:${installId}`;
}

export async function processWidgetChatMessage(params: {
  install: WidgetInstall;
  visitorId: string;
  message: string;
  conversationId?: number;
}): Promise<{
  reply: string;
  conversationId: number;
  attachment?: { url: string; type: string; caption?: string | null } | null;
}> {
  const { install, message } = params;
  const { conversation, businessProfile, historyTurns } =
    await setupWidgetChat(params);

  // 3. Early Exit if Manual Mode or AI Disabled for this thread
  if (
    businessProfile.responseMode === "MANUAL" ||
    conversation.aiEnabled === false
  ) {
    logger.info("widget.chat.automation_skip", {
      conversationId: conversation.id,
      reason:
        conversation.aiEnabled === false ? "AI_TOGGLE_OFF" : "MANUAL_MODE",
    });
    return {
      reply: "",
      conversationId: conversation.id,
    };
  }

  let reply: AiRoutingDecision;
  try {
    reply = await computeBusinessChatReply({
      businessProfile,
      messageText: message,
      historyTurns,
      channel: "web",
      conversationId: conversation.id,
    });
  } catch (err: unknown) {
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

  const isAutoMode = businessProfile.responseMode === "AUTO";
  const status =
    reply.action === "HANDOFF_TO_HUMAN" || !isAutoMode
      ? "PENDING_REVIEW"
      : "SENT";

  const botMsg = await saveMessage(
    conversation.id,
    "model",
    reply.content || "",
    {
      status,
      aiReasoning: reply.reasoning,
      handoffCategory: reply.handoffCategory,
    },
  );

  if (status === "PENDING_REVIEW") {
    if (reply.handoffCategory === "SYSTEM_ERROR") {
      // Store the internal error details for admin view
      await prisma.conversationMessage.update({
        where: { id: botMsg.id },
        data: { content: `Internal Technical Failure: ${reply.reasoning}` },
      });
      botMsg.content = `Internal Technical Failure: ${reply.reasoning}`;

      const { syncSystemError } =
        await import("@modules/realtime/socketSync.service");
      syncSystemError({
        businessProfileId: install.businessProfileId,
        conversationId: conversation.id,
        reason: reply.reasoning,
      });
      return {
        reply: "", // Silent to visitor
        conversationId: conversation.id,
      };
    }

    return {
      reply: reply.content || "",
      conversationId: conversation.id,
    };
  } else {
    logger.info("widget.chat.reply_sent", {
      widgetInstallId: install.id,
      conversationId: conversation.id,
      preview: (reply.content || "").substring(0, 80),
    });

    const { scheduleConversationFollowUps } =
      await import("@modules/follow-up/followUp.service");
    await scheduleConversationFollowUps({
      conversationId: conversation.id,
      businessProfileId: install.businessProfileId,
      triggerMessageId: botMsg.id,
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
 * Common setup logic for both streaming and non-streaming widget chat paths.
 */
async function setupWidgetChat(params: {
  install: WidgetInstall;
  visitorId: string;
  message: string;
  conversationId?: number;
}) {
  const { install, visitorId, message, conversationId } = params;
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
      externalDataSources: { where: { isActive: true } },
      crmIntegrations: { where: { isActive: true }, take: 1 },
    },
  });

  const historyRows = await getConversationHistory(conversation.id);
  await saveMessage(conversation.id, "user", message);

  const historyForPrompt = toPromptMessages(historyRows);
  historyForPrompt.push({ role: "user", content: message });
  const historyTurns = historyToLlmTurns(historyForPrompt);

  return { conversation, businessProfile, historyTurns };
}

/**
 * processWidgetChatStreaming — Generator for web widget SSE.
 */
export async function* processWidgetChatStreaming(params: {
  install: WidgetInstall;
  visitorId: string;
  message: string;
  conversationId?: number;
}) {
  const { install, message } = params;
  const { conversation, businessProfile, historyTurns } =
    await setupWidgetChat(params);

  // Mode Check
  if (
    businessProfile.responseMode === "MANUAL" ||
    conversation.aiEnabled === false
  ) {
    yield { type: "status", data: "MANUAL_MODE" };
    return;
  }

  const { computeBusinessChatStreaming } =
    await import("../../ai-agent/chat/businessChatReply.service");

  // Yield the conversation ID so the client can save it
  yield { type: "conversation_id", data: conversation.id };

  const stream = computeBusinessChatStreaming({
    businessProfile,
    messageText: params.message,
    historyTurns,
    channel: "web",
    conversationId: conversation.id,
  });

  for await (const event of stream) {
    yield event;
  }
}
