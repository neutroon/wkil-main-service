import prisma from "../../config/prisma";
import { logger } from "../../utils/logger";
import {
  getOrCreateConversation,
  getConversationHistory,
  saveMessage,
} from "../meta/conversation.service";
import { computeBusinessChatReply } from "../chat/businessChatReply.service";
import {
  historyToLlmTurns,
  toPromptMessages,
} from "../chat/conversationTurns";
import type { WidgetInstall } from "@prisma/client";
import { emitToConversation, emitToBusiness } from "../../utils/socket";

const FALLBACK_REPLY =
  "Sorry, we can't respond right now. Please try again or contact the business directly.";

function pageIdForWidget(installId: number): string {
  return `widget:${installId}`;
}

export async function processWidgetChatMessage(params: {
  install: WidgetInstall;
  visitorId: string;
  message: string;
  conversationId?: number;
}): Promise<{ reply: string; conversationId: number }> {
  const { install, visitorId, message, conversationId } = params;
  const pageId = pageIdForWidget(install.id);

  let conversation;
  if (conversationId !== undefined) {
    const verified = await prisma.conversation.findFirst({
      where: {
        id: conversationId,
        pageId,
        senderId: visitorId,
      },
    });
    if (!verified) {
      throw new Error("Invalid conversationId for this visitor");
    }
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
  const userMsg = await saveMessage(conversation.id, "user", message);

  // Notify Admin (Dashboard) about the new visitor message
  emitToBusiness(install.businessProfileId, "new_message", {
    conversationId: conversation.id,
    message: userMsg
  });

  const historyForPrompt = toPromptMessages(historyRows);
  historyForPrompt.push({ role: "user", content: message });
  const historyTurns = historyToLlmTurns(historyForPrompt);

  let reply: string;
  try {
    reply = await computeBusinessChatReply({
      businessProfile,
      messageText: message,
      historyTurns,
      channel: "web",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("widget.chat.ai_failed", {
      widgetInstallId: install.id,
      conversationId: conversation.id,
      error: msg,
    });
    reply = FALLBACK_REPLY;
  }

  const botMsg = await saveMessage(conversation.id, "model", reply);

  // Notify Visitor (Web Widget) and Admin (Dashboard) about the AI reply
  emitToConversation(conversation.id, "new_message", { message: botMsg });
  emitToBusiness(install.businessProfileId, "new_message", {
    conversationId: conversation.id,
    message: botMsg
  });

  logger.info("widget.chat.reply_sent", {
    widgetInstallId: install.id,
    conversationId: conversation.id,
    preview: reply.slice(0, 80),
  });

  return { reply, conversationId: conversation.id };
}
