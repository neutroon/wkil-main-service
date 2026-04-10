import prisma from "../../config/prisma";
import { logger } from "../../utils/logger";
import {
  getOrCreateConversation,
  getConversationHistory,
  saveMessage,
} from "../meta/conversation.service";
import { computeBusinessChatReply } from "../chat/businessChatReply.service";
import { AiRoutingDecision } from "../ai/aiEngine.service";
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
  
  // 3. Early Exit if Manual Mode
  if (businessProfile.responseMode === "MANUAL") {
    logger.info("widget.chat.manual_mode_skip", { 
      conversationId: conversation.id,
      businessProfileId: businessProfile.id 
    });
    return { 
      reply: "", // Silent to visitor
      conversationId: conversation.id 
    };
  }

  let reply: AiRoutingDecision;
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
    reply = {
      action: "HANDOFF_TO_HUMAN",
      handoffCategory: "SYSTEM_ERROR",
      reasoning: `Infrastructure Failure: ${msg}`,
      content: null
    };
  }

  if (reply.action === "RESOLVE_CONVERSATION") {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { status: "RESOLVED" }
    });
    logger.info("widget.chat.conversation_resolved_by_ai", { conversationId: conversation.id });
    return { reply: "", conversationId: conversation.id };
  }

  const isAutoMode = businessProfile.responseMode === "AUTO";
  const status = reply.action === "HANDOFF_TO_HUMAN" || !isAutoMode ? "PENDING_REVIEW" : "SENT";

  const botMsg = await saveMessage(conversation.id, "model", reply.content || "", {
    status,
    aiReasoning: reply.reasoning,
    handoffCategory: reply.handoffCategory
  });

  if (status === "PENDING_REVIEW") {
    emitToBusiness(install.businessProfileId, "draft_received", {
      conversationId: conversation.id,
      message: botMsg
    });

    if (reply.handoffCategory === "SYSTEM_ERROR") {
      // Store the internal error details for admin view
      await prisma.conversationMessage.update({
        where: { id: botMsg.id },
        data: { content: `Internal Technical Failure: ${reply.reasoning}` }
      });
      botMsg.content = `Internal Technical Failure: ${reply.reasoning}`;

      // Re-emit for system error visibility
      emitToBusiness(install.businessProfileId, "new_message", {
        conversationId: conversation.id,
        message: botMsg
      });

      emitToBusiness(install.businessProfileId, "system_critical_error", {
        conversationId: conversation.id,
        reason: reply.reasoning
      });
      return { 
        reply: "", // Silent to visitor
        conversationId: conversation.id 
      };
    }

    return { 
      reply: "An agent has been notified and will be with you shortly.", 
      conversationId: conversation.id 
    };
  } else {
    // Notify Visitor (Web Widget) and Admin (Dashboard) about the AI reply
    emitToConversation(conversation.id, "new_message", { message: botMsg });
    emitToBusiness(install.businessProfileId, "new_message", {
      conversationId: conversation.id,
      message: botMsg
    });

    logger.info("widget.chat.reply_sent", {
      widgetInstallId: install.id,
      conversationId: conversation.id,
      preview: (reply.content || "").substring(0, 80),
    });

    return { reply: reply.content || "", conversationId: conversation.id };
  }
}
