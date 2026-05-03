import { Router, Request, Response } from "express";

import { authenticateToken } from "../../middlewares/auth.middleware";
import { logger } from "../../utils/logger";
import prisma from "../../config/prisma";
import {
  listWhatsAppConversations,
  listConversationMessages,
  getConversationForUser,
  saveMessage,
} from "../../services/meta/conversation.service";
import {
  sendWhatsAppReply,
} from "../../services/meta/whatsapp.service";
import {
  sendMessengerReply,
  sendMessengerAction,
} from "../../services/meta/messenger.service";
import { decryptFacebookSecret } from "../../utils/tokenCrypto";
import { computeBusinessChatReply } from "../../services/chat/businessChatReply.service";
import {
  toPromptMessages,
  historyToLlmTurns,
} from "../../services/chat/conversationTurns";
import { getConversationHistory } from "../../services/meta/conversation.service";
import { resumeAgentGraph } from "../../services/ai/agentGraph";
import { validate } from "../../middlewares/validate.middleware";
import {
  toggleAiSchema,
  updateStatusSchema,
  sendMessageSchema,
} from "../../validations/conversation.validation";
import { sendWhatsAppTemplateSchema } from "../../validations/meta.validation";
import { AppError } from "../../middlewares/errorHandler.middleware";

import {
  paginationSchema,
  idPaginationSchema,
  idParamSchema,
} from "../../validations/shared.validation";
import { z } from "zod";

const conversationsRoutes = Router();

// ─────────────────────────────────────────────────────────────────────────────

// ─── Helpers ─────────────────────────────────────────────────────────────────

// ─── Shared Helpers ───────────────────────────────────────────────────────────

async function getUserPhoneNumberIds(userId: number): Promise<string[]> {
  // 1. Resolve all BusinessProfiles owned by this user
  const profiles = await prisma.businessProfile.findMany({
    where: { userId },
    select: { id: true },
  });
  const profileIds = profiles.map((p) => p.id);

  if (profileIds.length === 0) {
    return [];
  }

  // 2. Resolve all IDs (WA, FB, Widget) linked to these profiles
  const [waAccounts, fbPages, widgets] = await Promise.all([
    prisma.whatsAppAccount.findMany({
      where: { businessProfileId: { in: profileIds }, isActive: true },
      select: { phoneNumberId: true },
    }),
    prisma.facebookPage.findMany({
      where: { businessProfileId: { in: profileIds }, isActive: true },
      select: { pageId: true },
    }),
    prisma.widgetInstall.findMany({
      where: { businessProfileId: { in: profileIds }, isActive: true },
      select: { id: true },
    }),
  ]);

  const waIds = waAccounts.map((a) => a.phoneNumberId);
  const fbIds = fbPages.map((p) => p.pageId);
  const widgetIds = widgets.map((w) => `widget:${w.id}`);

  return [...waIds, ...fbIds, ...widgetIds];
}

// ─── GET /v1/whatsapp/conversations ──────────────────────────────────────────
/**
 * List paginated WhatsApp conversations for the authenticated user.
 *
 * Query params:
 *   page  (default: 1)
 *   limit (default: 20, max: 100)
 *
 * Response:
 *   {
 *     data: ConversationSummary[],
 *     meta: { total, page, limit, totalPages }
 *   }
 */
conversationsRoutes.get(
  "/",
  authenticateToken,
  validate(paginationSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const { page, limit, status } = req.query as any;

    const result = await listWhatsAppConversations(userId, page, limit, status);
    return res.json(result);
  },
);

conversationsRoutes.get(
  "/:id/messages",
  authenticateToken,
  validate(idPaginationSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;

    // Authorisation: ensure this conversation belongs to the caller
    const phoneNumberIds = await getUserPhoneNumberIds(userId);
    if (phoneNumberIds.length === 0) {
      throw new AppError("Conversation not found", 404);
    }

    const conversation = await getConversationForUser(
      conversationId,
      phoneNumberIds,
    );
    if (!conversation) {
      throw new AppError("Conversation not found", 404);
    }

    const { limit, cursor } = req.query as any;

    const result = await listConversationMessages(
      conversationId,
      limit,
      cursor,
    );

    // Enrich with conversation metadata for the UI
    const accounts = await prisma.whatsAppAccount.findMany({
      where: { phoneNumberId: conversation.pageId, userId },
      select: { displayPhoneNumber: true },
    });

    return res.json({
      conversation: {
        ...conversation,
        displayPhoneNumber:
          accounts[0]?.displayPhoneNumber ?? conversation.pageId,
        customerPhone: conversation.customerPhone ?? conversation.senderId,
      },
      ...result,
    });
  },
);

// ─── PATCH /v1/whatsapp/conversations/:id/read ───────────────────────────────
/**
 * Mark a conversation as read (no-op stub — readAt column can be added later).
 * Returns 404 if the conversation doesn't belong to the authenticated user.
 *
 * Response:
 *   { success: true }
 */
conversationsRoutes.patch(
  "/:id/read",
  authenticateToken,
  validate(idParamSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;

    const phoneNumberIds = await getUserPhoneNumberIds(userId);
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, pageId: { in: phoneNumberIds } },
    });
    if (!conversation) throw new AppError("Conversation not found", 404);

    // 1. Dispatch signal to Meta platform
    if (conversation.channel === "messenger") {
      const page = await prisma.facebookPage.findFirst({
        where: { pageId: conversation.pageId, isActive: true },
        select: { pageAccessToken: true },
      });
      if (page) {
        const token = decryptFacebookSecret(page.pageAccessToken);
        await sendMessengerAction(
          conversation.senderId,
          "mark_seen",
          token,
        ).catch((e) =>
          logger.warn("meta.read_signal_failed", {
            conversationId,
            error: e.message,
          }),
        );
      }
    }

    // 2. Update DB read status
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { readAt: new Date() },
    });

    return res.json({ success: true });
  },
);

/**
 * POST /v1/meta/conversations/:id/typing
 * Trigger typing signal for customer
 */
conversationsRoutes.post(
  "/:id/typing",
  authenticateToken,
  validate(idParamSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;
    const { typing } = req.body as { typing: boolean };

    const phoneNumberIds = await getUserPhoneNumberIds(userId);
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, pageId: { in: phoneNumberIds } },
    });
    if (!conversation) throw new AppError("Not found", 404);

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
          token,
        ).catch((e) =>
          logger.warn("meta.typing_signal_failed", {
            conversationId,
            error: e.message,
          }),
        );
      }
    }

    return res.json({ success: true });
  },
);

/**
 * PATCH /v1/meta/conversations/:id/ai-toggle
 */
conversationsRoutes.patch(
  "/:id/ai-toggle",
  authenticateToken,
  validate(idParamSchema),
  validate(toggleAiSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;
    const { enabled } = req.body;

    const phoneNumberIds = await getUserPhoneNumberIds(userId);
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, pageId: { in: phoneNumberIds } },
    });

    if (!conversation) throw new AppError("Conversation not found", 404);

    const updated = await prisma.conversation.update({
      where: { id: conversationId },
      data: { aiEnabled: enabled },
    });

    logger.info("meta.conversation.ai_toggle", {
      conversationId,
      enabled,
      userId,
    });
    return res.json({ data: updated });
  },
);

/**
 * PATCH /v1/meta/conversations/:id/status
 */
conversationsRoutes.patch(
  "/:id/status",
  authenticateToken,
  validate(idParamSchema),
  validate(updateStatusSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;
    const { status } = req.body;

    const phoneNumberIds = await getUserPhoneNumberIds(userId);
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, pageId: { in: phoneNumberIds } },
    });

    if (!conversation) throw new AppError("Not found", 404);

    const updated = await prisma.conversation.update({
      where: { id: conversationId },
      data: { status },
    });

    return res.json({ data: updated });
  },
);

/**
 * DELETE /v1/meta/conversations/:id
 */
conversationsRoutes.delete(
  "/:id",
  authenticateToken,
  validate(idParamSchema),
  async (req: Request, res: Response) => {
    const user = (req as any).user;
    const isAdmin = user.role === "admin" || user.role === "super_admin";

    if (!isAdmin)
      throw new AppError("Only admins can perform a hard delete.", 403);

    const { id: conversationId } = req.params as any;
    const phoneNumberIds = await getUserPhoneNumberIds(user.id);

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, pageId: { in: phoneNumberIds } },
    });

    if (!conversation) throw new AppError("Not found", 404);

    await prisma.conversation.delete({ where: { id: conversationId } });
    return res.json({ success: true, message: "Conversation deleted." });
  },
);

// ─── POST /v1/whatsapp/conversations/:id/messages ────────────────────────────
conversationsRoutes.post(
  "/:id/messages",
  authenticateToken,
  validate(idParamSchema),
  validate(sendMessageSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;
    const { message: text } = req.body;

    const phoneNumberIds = await getUserPhoneNumberIds(userId);
    const conversation = await getConversationForUser(
      conversationId,
      phoneNumberIds,
    );
    if (!conversation) throw new AppError("Conversation not found", 404);

    const account = await prisma.whatsAppAccount.findFirst({
      where: { phoneNumberId: conversation.pageId, userId, isActive: true },
      select: { accessToken: true, phoneNumberId: true },
    });

    if (!account) throw new AppError("WhatsApp account not found", 404);

    const accessToken = decryptFacebookSecret(account.accessToken);
    const customerPhone = conversation.customerPhone ?? conversation.senderId;
    const trimmedText = text.trim();

    const {
      sendWhatsAppReply,
    } = require("../../services/meta/whatsapp.service");
    const platformRes = await sendWhatsAppReply(
      customerPhone,
      trimmedText,
      account.phoneNumberId,
      accessToken,
    );
    const wamid = (platformRes as any)?.messages?.[0]?.id;

    const saved = await saveMessage(conversationId, "agent", trimmedText, {
      externalId: wamid,
    });

    logger.info("whatsapp.conversations.human_sent", {
      conversationId,
      to: customerPhone,
      wamid,
    });
    return res.status(201).json({ data: saved });
  },
);

// ─── GET /v1/whatsapp/templates ───────────────────────────────────────────────
conversationsRoutes.get(
  "/templates",
  authenticateToken,
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;

    const account = await prisma.whatsAppAccount.findFirst({
      where: { userId, isActive: true },
      select: { wabaId: true, accessToken: true },
    });

    if (!account || !account.wabaId) return res.json({ data: [] });

    const accessToken = decryptFacebookSecret(account.accessToken);
    const {
      listWhatsAppTemplates,
    } = require("../../services/meta/whatsapp.service");
    const templates = await listWhatsAppTemplates(account.wabaId, accessToken);

    return res.json({ data: templates });
  },
);

// ─── POST /v1/whatsapp/conversations/:id/template ────────────────────────────
conversationsRoutes.post(
  "/:id/template",
  authenticateToken,
  validate(idParamSchema),
  validate(sendWhatsAppTemplateSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;
    const { templateName, languageCode, components, textPreview } = req.body;

    const phoneNumberIds = await getUserPhoneNumberIds(userId);
    const conversation = await getConversationForUser(
      conversationId,
      phoneNumberIds,
    );
    if (!conversation) throw new AppError("Conversation not found", 404);

    const account = await prisma.whatsAppAccount.findFirst({
      where: { phoneNumberId: conversation.pageId, userId, isActive: true },
      select: { accessToken: true, phoneNumberId: true },
    });

    if (!account) throw new AppError("WhatsApp account not found", 404);

    const accessToken = decryptFacebookSecret(account.accessToken);
    const customerPhone = conversation.customerPhone ?? conversation.senderId;

    const {
      sendWhatsAppTemplate,
    } = require("../../services/meta/whatsapp.service");
    await sendWhatsAppTemplate(
      customerPhone,
      templateName,
      languageCode,
      components || [],
      account.phoneNumberId,
      accessToken,
    );

    const saved = await saveMessage(
      conversationId,
      "agent",
      textPreview || `[Template: ${templateName}]`,
    );
    return res.status(201).json({ data: saved });
  },
);

// ============================================================================
// HITL (Approve / Edit / Send Drafts)
// ============================================================================
conversationsRoutes.put(
  "/:id/messages/:mid/approve",
  authenticateToken,
  validate(idParamSchema),
  async (req: Request, res: Response) => {
    const { id: conversationId } = req.params as any;
    const messageId = z.coerce.number().int().positive().parse(req.params.mid);
    const { editedContent } = req.body;
    const userId = (req as any).user.id;

    if (!editedContent) throw new AppError("editedContent is required.", 400);

    const phoneNumberIds = await getUserPhoneNumberIds(userId);
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, pageId: { in: phoneNumberIds } },
    });

    if (!conversation)
      throw new AppError("Conversation not found or access denied.", 404);

    const message = await prisma.conversationMessage.findUnique({
      where: { id: messageId, conversationId },
    });

    if (
      !message ||
      message.role !== "model" ||
      message.status !== "PENDING_REVIEW"
    ) {
      throw new AppError(
        "Message not found or is not a pending AI draft.",
        400,
      );
    }

    const isEdited = message.content !== editedContent;

    // 1. Transactionally record the correction and mark send
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

    // 1.5 Resume LangGraph to finalize state (record usage, clear interrupt)
    try {
      await resumeAgentGraph(conversation.id, editedContent);
    } catch (graphErr: any) {
      logger.warn("meta.hitl.graph_resume_failed", {
        conversationId,
        error: graphErr.message,
        info: "Continuing with dispatch anyway (safety first)"
      });
    }

    // 2. Dispatch via Meta API
    let externalId: string | undefined;
    if (conversation.channel === "messenger") {
      const page = await prisma.facebookPage.findFirst({
        where: { pageId: conversation.pageId, isActive: true },
        select: { pageAccessToken: true },
      });
      if (!page)
        throw new AppError(
          "Missing Facebook Page Access Token for dispatch.",
          502,
        );
      const pageToken = decryptFacebookSecret(page.pageAccessToken);
      const fbRes = await sendMessengerReply(
        conversation.senderId,
        editedContent,
        pageToken,
      );
      externalId = (fbRes as any)?.message_id;
      logger.info("messenger.hitl.approved", {
        messageId: message.id,
        mid: externalId,
      });
    } else {
      const waAccount = await prisma.whatsAppAccount.findFirst({
        where: { phoneNumberId: conversation.pageId, userId, isActive: true },
        select: { accessToken: true },
      });
      if (!waAccount)
        throw new AppError("Missing WhatsApp Account for dispatch.", 502);
      const waToken = decryptFacebookSecret(waAccount.accessToken);
      const waRes = await sendWhatsAppReply(
        conversation.senderId,
        editedContent,
        conversation.pageId,
        waToken,
      );
      externalId = (waRes as any)?.messages?.[0]?.id;
      logger.info("whatsapp.hitl.approved", {
        messageId: message.id,
        wamid: externalId,
      });
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
  },
);

/** DELETE /v1/meta/conversations/:id/messages/:mid — dismiss a draft */
conversationsRoutes.delete(
  "/:id/messages/:mid",
  authenticateToken,
  validate(idParamSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;
    const messageId = z.coerce.number().int().positive().parse(req.params.mid);

    const phoneNumberIds = await getUserPhoneNumberIds(userId);
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, pageId: { in: phoneNumberIds } },
    });

    if (!conversation) throw new AppError("Not found", 404);

    const msg = await prisma.conversationMessage.findFirst({
      where: { id: messageId, conversationId, status: "PENDING_REVIEW" },
    });

    if (!msg) throw new AppError("Draft not found", 404);

    await prisma.conversationMessage.delete({ where: { id: messageId } });
    return res.json({ success: true });
  },
);

// ─── POST /v1/meta/conversations/:id/suggest ──────────────────────────────────
conversationsRoutes.post(
  "/:id/suggest",
  authenticateToken,
  validate(idParamSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;

    const phoneNumberIds = await getUserPhoneNumberIds(userId);
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, pageId: { in: phoneNumberIds } },
      include: {
        businessProfile: {
          include: {
            externalDataSources: { where: { isActive: true } },
            crmIntegrations: { where: { isActive: true }, take: 1 },
          },
        },
      },
    });

    if (!conversation)
      throw new AppError("Conversation not found or access denied.", 404);

    const historyRows = await getConversationHistory(conversation.id);
    if (historyRows.length === 0)
      throw new AppError(
        "Cannot suggest a reply for an empty conversation.",
        400,
      );

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
  },
);

export default conversationsRoutes;
