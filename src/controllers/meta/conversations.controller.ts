import { Request, Response } from "express";
import prisma from "../../config/prisma";
import { logger } from "../../utils/logger";
import { decryptFacebookSecret } from "../../utils/tokenCrypto";
import {
  listConversationMessages,
} from "../../services/meta/conversation.service";
import {
  sendWhatsAppReply,
} from "../../services/meta/whatsapp.service";
import {
  sendMessengerReply,
  sendMessengerAction,
} from "../../services/meta/messenger.service";
import { computeBusinessChatReply } from "../../services/chat/businessChatReply.service";
import {
  toPromptMessages,
  historyToLlmTurns,
} from "../../services/chat/conversationTurns";
import { getConversationHistory } from "../../services/meta/conversation.service";
import { resumeAgentGraph } from "../../services/ai/agentGraph";
import { AppError } from "../../middlewares/errorHandler.middleware";
import { z } from "zod";

export class ConversationsController {
  /**
   * Verify that the given conversation belongs to the authenticated user,
   * using businessProfileId as the channel-agnostic ownership check.
   * Throws 404 if not found or not owned.
   */
  async getAuthorizedConversation(userId: number, conversationId: number) {
    const profiles = await prisma.businessProfile.findMany({
      where: { userId },
      select: { id: true },
    });
    const profileIds = profiles.map((p) => p.id);

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, businessProfileId: { in: profileIds } },
    });

    if (!conversation) throw new AppError("Conversation not found or access denied.", 404);
    return conversation;
  }

  /**
   * GET /v1/meta/conversations/:id/messages
   */
  async listMessages(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;
    const { limit, cursor } = req.query as any;

    const conversation = await this.getAuthorizedConversation(userId, conversationId);
    const result = await listConversationMessages(conversationId, limit, cursor);

    const accounts = await prisma.whatsAppAccount.findMany({
      where: { phoneNumberId: conversation.pageId, userId },
      select: { displayPhoneNumber: true },
    });

    return res.json({
      conversation: {
        ...conversation,
        displayPhoneNumber: accounts[0]?.displayPhoneNumber ?? conversation.pageId,
        customerPhone: conversation.customerPhone ?? conversation.senderId,
      },
      ...result,
    });
  }

  /**
   * PATCH /v1/meta/conversations/:id/read
   */
  async markRead(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;

    const conversation = await this.getAuthorizedConversation(userId, conversationId);

    if (conversation.channel === "messenger") {
      const page = await prisma.facebookPage.findFirst({
        where: { pageId: conversation.pageId, isActive: true },
        select: { pageAccessToken: true },
      });
      if (page) {
        const token = decryptFacebookSecret(page.pageAccessToken);
        await sendMessengerAction(conversation.senderId, "mark_seen", token).catch((e) =>
          logger.warn("meta.read_signal_failed", { conversationId, error: e.message })
        );
      }
    }

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { readAt: new Date() },
    });

    return res.json({ success: true });
  }

  /**
   * POST /v1/meta/conversations/:id/typing
   */
  async sendTypingSignal(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;
    const { typing } = req.body as { typing: boolean };

    const conversation = await this.getAuthorizedConversation(userId, conversationId);

    if (conversation.channel === "messenger") {
      const page = await prisma.facebookPage.findFirst({
        where: { pageId: conversation.pageId, isActive: true },
        select: { pageAccessToken: true },
      });
      if (page) {
        const token = decryptFacebookSecret(page.pageAccessToken);
        await sendMessengerAction(
          conversation.senderId,
          typing ? "typing_on" : "typing_off",
          token
        ).catch((e) =>
          logger.warn("meta.typing_signal_failed", { conversationId, error: e.message })
        );
      }
    }

    return res.json({ success: true });
  }

  /**
   * PATCH /v1/meta/conversations/:id/ai-toggle
   */
  async toggleAi(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;
    const { enabled } = req.body;

    await this.getAuthorizedConversation(userId, conversationId);

    const updated = await prisma.conversation.update({
      where: { id: conversationId },
      data: { aiEnabled: enabled },
    });

    logger.info("meta.conversation.ai_toggle", { conversationId, enabled, userId });
    return res.json({ data: updated });
  }

  /**
   * PATCH /v1/meta/conversations/:id/status
   */
  async updateStatus(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;
    const { status } = req.body;

    await this.getAuthorizedConversation(userId, conversationId);

    const updated = await prisma.conversation.update({
      where: { id: conversationId },
      data: { status },
    });

    return res.json({ data: updated });
  }

  /**
   * DELETE /v1/meta/conversations/:id
   */
  async deleteConversation(req: Request, res: Response) {
    const user = (req as any).user;
    const isAdmin = user.role === "admin" || user.role === "super_admin";

    if (!isAdmin) throw new AppError("Only admins can perform a hard delete.", 403);

    const { id: conversationId } = req.params as any;
    await this.getAuthorizedConversation(user.id, conversationId);

    await prisma.conversation.delete({ where: { id: conversationId } });
    return res.json({ success: true, message: "Conversation deleted." });
  }

  /**
   * PUT /v1/meta/conversations/:id/messages/:mid/approve
   */
  async approveAiDraft(req: Request, res: Response) {
    const { id: conversationId } = req.params as any;
    const messageId = z.coerce.number().int().positive().parse(req.params.mid);
    const { editedContent } = req.body;
    const userId = (req as any).user.id;

    if (!editedContent) throw new AppError("editedContent is required.", 400);

    const conversation = await this.getAuthorizedConversation(userId, conversationId);

    const message = await prisma.conversationMessage.findUnique({
      where: { id: messageId, conversationId },
    });

    if (!message || message.role !== "model" || message.status !== "PENDING_REVIEW") {
      throw new AppError("Message not found or is not a pending AI draft.", 400);
    }

    const isEdited = message.content !== editedContent;

    await prisma.$transaction(async (tx) => {
      if (isEdited) {
        await tx.aiCorrection.create({
          data: {
            messageId: message.id,
            originalAiText: message.content,
            humanEditedText: editedContent,
          },
        });
      }
      await tx.conversationMessage.update({
        where: { id: message.id },
        data: {
          content: editedContent,
          status: isEdited ? "EDITED_AND_SENT" : "SENT",
        },
      });

      if (conversation.status === "RESOLVED") {
        await tx.conversation.update({
          where: { id: conversation.id },
          data: { status: "OPEN" },
        });
      }
    });

    try {
      await resumeAgentGraph(conversation.id, editedContent);
    } catch (graphErr: any) {
      logger.warn("meta.hitl.graph_resume_failed", { conversationId, error: graphErr.message });
    }

    let externalId: string | undefined;
    if (conversation.channel === "messenger") {
      const page = await prisma.facebookPage.findFirst({
        where: { pageId: conversation.pageId, isActive: true },
        select: { pageAccessToken: true },
      });
      if (!page) throw new AppError("Missing Facebook Page Access Token for dispatch.", 502);
      const pageToken = decryptFacebookSecret(page.pageAccessToken);
      const fbRes = await sendMessengerReply(conversation.senderId, editedContent, pageToken);
      externalId = (fbRes as any)?.message_id;
    } else {
      const waAccount = await prisma.whatsAppAccount.findFirst({
        where: { phoneNumberId: conversation.pageId, userId, isActive: true },
        select: { accessToken: true },
      });
      if (!waAccount) throw new AppError("Missing WhatsApp Account for dispatch.", 502);
      const waToken = decryptFacebookSecret(waAccount.accessToken);
      const waRes = await sendWhatsAppReply(conversation.senderId, editedContent, conversation.pageId, waToken);
      externalId = (waRes as any)?.messages?.[0]?.id;
    }

    if (externalId) {
      await prisma.conversationMessage.update({
        where: { id: message.id },
        data: { externalId },
      });
    }

    const updatedMsgFull = await prisma.conversationMessage.findUnique({
      where: { id: message.id },
    });
    return res.json({ data: updatedMsgFull });
  }

  /**
   * DELETE /v1/meta/conversations/:id/messages/:mid
   */
  async dismissAiDraft(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;
    const messageId = z.coerce.number().int().positive().parse(req.params.mid);

    await this.getAuthorizedConversation(userId, conversationId);

    const msg = await prisma.conversationMessage.findFirst({
      where: { id: messageId, conversationId, status: "PENDING_REVIEW" },
    });

    if (!msg) throw new AppError("Draft not found", 404);

    await prisma.conversationMessage.delete({ where: { id: messageId } });
    return res.json({ success: true });
  }

  /**
   * POST /v1/meta/conversations/:id/suggest
   */
  async suggestReply(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;

    await this.getAuthorizedConversation(userId, conversationId);
    
    const profiles = await prisma.businessProfile.findMany({
      where: { userId },
      select: { id: true },
    });
    const profileIds = profiles.map((p) => p.id);
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, businessProfileId: { in: profileIds } },
      include: {
        businessProfile: {
          include: {
            externalDataSources: { where: { isActive: true } },
            crmIntegrations: { where: { isActive: true }, take: 1 },
          },
        },
      },
    });

    if (!conversation) throw new AppError("Conversation not found or access denied.", 404);

    const historyRows = await getConversationHistory(conversation.id);
    if (historyRows.length === 0) throw new AppError("Cannot suggest a reply for an empty conversation.", 400);

    const lastUserMsg = historyRows[historyRows.length - 1];
    const historyTurns = historyToLlmTurns(toPromptMessages(historyRows));

    const reply = await computeBusinessChatReply({
      businessProfile: conversation.businessProfile,
      messageText: lastUserMsg?.content || "",
      historyTurns,
      channel: (conversation.channel as any) || "whatsapp",
      conversationId: conversation.id,
      responseMode: "MANUAL",
    });

    const saved = await prisma.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        role: "model",
        content: reply.content || "",
        status: "PENDING_REVIEW",
        aiReasoning: reply.reasoning,
        handoffCategory: reply.handoffCategory,
      },
    });

    return res.status(201).json({ data: saved });
  }
}

export const conversationsController = new ConversationsController();
