import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import {
  getOrCreateConversation,
  getConversationHistory,
  saveMessage,
} from "@modules/meta/core/conversation.service";
import { upsertCustomerFromConversation } from "@modules/business/customer/customer.service";
import { computeBusinessChatReply } from "@modules/ai-agent/chat/businessChatReply.service";
import { initialCustomerReplyStatus } from "@modules/ai-agent/chat/deliveryPolicy";
import {
  notifySavedModelReplySideEffects,
  scheduleFollowUpsForDeliveredReply,
} from "@modules/ai-agent/chat/replySideEffects.service";
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
    await notifySavedModelReplySideEffects({
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

  await notifySavedModelReplySideEffects({
    businessProfileId: install.businessProfileId,
    conversationId: conversation.id,
    message: botMsg,
    reply,
  });

  {
    logger.info("widget.chat.reply_sent", {
      widgetInstallId: install.id,
      conversationId: conversation.id,
      preview: (reply.content || "").substring(0, 80),
    });

    await scheduleFollowUpsForDeliveredReply({
      conversationId: conversation.id,
      businessProfileId: install.businessProfileId,
      message: botMsg,
      reply,
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

  if (conversation.aiEnabled === false) {
    yield { type: "status", data: "AI_DISABLED" };
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
