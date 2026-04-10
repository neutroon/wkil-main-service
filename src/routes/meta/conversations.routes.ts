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
import { sendWhatsAppReply } from "../../services/meta/whatsapp.service";
import { sendMessengerReply } from "../../services/meta/messenger.service";
import { decryptFacebookSecret } from "../../utils/tokenCrypto";
import { emitToBusiness, emitToConversation } from "../../utils/socket";
import { computeBusinessChatReply } from "../../services/ai/aiEngine.service";
import { toPromptMessages, historyToLlmTurns } from "../../services/chat/conversationTurns";
import { getConversationHistory } from "../../services/meta/conversation.service";

const conversationsRoutes = Router();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parsePagination(
  query: Record<string, unknown>,
  defaultLimit = 20,
): { page: number; limit: number } {
  const page = Math.max(1, parseInt(String(query.page ?? "1"), 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, parseInt(String(query.limit ?? String(defaultLimit)), 10) || defaultLimit),
  );
  return { page, limit };
}

async function getUserPhoneNumberIds(userId: number): Promise<string[]> {
  const accounts = await prisma.whatsAppAccount.findMany({
    where: { userId, isActive: true },
    select: { phoneNumberId: true },
  });
  return accounts.map((a) => a.phoneNumberId);
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
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id as number;
      const { page, limit } = parsePagination(req.query as Record<string, unknown>);

      const result = await listWhatsAppConversations(userId, page, limit);
      return res.json(result);
    } catch (error: any) {
      logger.error("whatsapp.conversations.list_failed", { error: error.message });
      return res.status(500).json({ error: error.message });
    }
  },
);

// ─── GET /v1/whatsapp/conversations/:id/messages ──────────────────────────────
/**
 * Return paginated messages for a single conversation.
 * Returns 404 if the conversation doesn't belong to the authenticated user.
 *
 * Query params:
 *   page  (default: 1)
 *   limit (default: 50, max: 100)
 *
 * Response:
 *   {
 *     conversation: { id, customerPhone, displayPhoneNumber, createdAt, updatedAt },
 *     data: Message[],
 *     meta: { total, page, limit, totalPages }
 *   }
 */
conversationsRoutes.get(
  "/:id/messages",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id as number;
      const conversationId = parseInt(req.params.id, 10);

      if (isNaN(conversationId)) {
        return res.status(400).json({ error: "Invalid conversation id" });
      }

      // Authorisation: ensure this conversation belongs to the caller
      const phoneNumberIds = await getUserPhoneNumberIds(userId);
      if (phoneNumberIds.length === 0) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const conversation = await getConversationForUser(conversationId, phoneNumberIds);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const { page, limit } = parsePagination(
        req.query as Record<string, unknown>,
        50,
      );

      const result = await listConversationMessages(conversationId, page, limit);

      // Enrich with conversation metadata for the UI
      const accounts = await prisma.whatsAppAccount.findMany({
        where: { phoneNumberId: conversation.pageId, userId },
        select: { displayPhoneNumber: true },
      });

      return res.json({
        conversation: {
          id: conversation.id,
          businessProfileId: conversation.businessProfileId,
          phoneNumberId: conversation.pageId,
          displayPhoneNumber: accounts[0]?.displayPhoneNumber ?? conversation.pageId,
          customerPhone: conversation.customerPhone ?? conversation.senderId,
          channel: conversation.channel,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
        },
        ...result,
      });
    } catch (error: any) {
      logger.error("whatsapp.conversations.messages_failed", { error: error.message });
      return res.status(500).json({ error: error.message });
    }
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
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id as number;
      const conversationId = parseInt(req.params.id, 10);

      if (isNaN(conversationId)) {
        return res.status(400).json({ error: "Invalid conversation id" });
      }

      const phoneNumberIds = await getUserPhoneNumberIds(userId);
      if (phoneNumberIds.length === 0) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const conversation = await getConversationForUser(conversationId, phoneNumberIds);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      // Placeholder — touch updatedAt so the frontend can optimistically reflect
      // the read state via timestamp comparison until a `readAt` column is added.
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { updatedAt: conversation.updatedAt }, // no-op update keeps the record
      });

      return res.json({ success: true });
    } catch (error: any) {
      logger.error("whatsapp.conversations.read_failed", { error: error.message });
      return res.status(500).json({ error: error.message });
    }
  },
);

// ─── POST /v1/whatsapp/conversations/:id/messages ────────────────────────────
/**
 * Send a human-initiated outbound message from the dashboard.
 *
 * Body: { text: string }
 *
 * - Looks up the WhatsApp account for the conversation's phoneNumberId.
 * - Sends the message via Cloud API.
 * - Saves it with role "model" (business-sent).
 * - Returns the saved ConversationMessage.
 */
conversationsRoutes.post(
  "/:id/messages",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id as number;
      const conversationId = parseInt(req.params.id, 10);

      if (isNaN(conversationId)) {
        return res.status(400).json({ error: "Invalid conversation id" });
      }

      const { text } = req.body as { text?: unknown };
      if (!text || typeof text !== "string" || !text.trim()) {
        return res.status(400).json({ error: "text is required" });
      }

      // Auth: conversation must belong to one of the user's phone numbers
      const phoneNumberIds = await getUserPhoneNumberIds(userId);
      if (phoneNumberIds.length === 0) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const conversation = await getConversationForUser(conversationId, phoneNumberIds);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      // Retrieve the WA account to get the encrypted access token
      const account = await prisma.whatsAppAccount.findFirst({
        where: { phoneNumberId: conversation.pageId, userId, isActive: true },
        select: { accessToken: true, phoneNumberId: true },
      });

      if (!account) {
        return res.status(404).json({ error: "WhatsApp account not found" });
      }

      let accessToken: string;
      try {
        accessToken = decryptFacebookSecret(account.accessToken);
      } catch {
        return res.status(500).json({ error: "Failed to decrypt account credentials" });
      }

      const customerPhone = conversation.customerPhone ?? conversation.senderId;
      const trimmedText = text.trim();

      // 1. Send via WhatsApp Cloud API FIRST
      try {
        await sendWhatsAppReply(customerPhone, trimmedText, account.phoneNumberId, accessToken);
      } catch (apiErr: any) {
        logger.error("whatsapp.conversations.send_failed", {
          conversationId,
          error: apiErr.message,
        });
        // Passing back the specific Meta error to the frontend
        return res.status(502).json({ 
          error: "WhatsApp Cloud API error", 
          detail: apiErr.message,
          code: apiErr.response?.data?.error?.code // Try to capture Meta error code if available
        });
      }

      // 2. Persist ONLY if API call succeeded
      const saved = await saveMessage(conversationId, "model", trimmedText);

      emitToBusiness(conversation.businessProfileId, "new_message", {
        conversationId: conversation.id,
        message: saved,
      });
      emitToConversation(conversation.id, "new_message", {
        message: saved,
      });

      logger.info("whatsapp.conversations.human_sent", {
        conversationId,
        to: customerPhone,
        preview: trimmedText.slice(0, 80),
      });

      return res.status(201).json({ data: saved });
    } catch (error: any) {
      logger.error("whatsapp.conversations.send_error", { error: error.message });
      return res.status(500).json({ error: error.message });
    }
  },
);

// ─── GET /v1/whatsapp/templates ───────────────────────────────────────────────
/**
 * List all approved WhatsApp templates for the authenticated user's active account.
 */
conversationsRoutes.get(
  "/templates",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id as number;
      
      // Get the first active WhatsApp account for this user
      const account = await prisma.whatsAppAccount.findFirst({
        where: { userId, isActive: true },
        select: { wabaId: true, accessToken: true },
      });

      if (!account || !account.wabaId) {
        return res.json({ data: [] }); // Graceful empty state
      }

      let accessToken: string;
      try {
        accessToken = decryptFacebookSecret(account.accessToken);
      } catch {
        return res.status(500).json({ error: "Failed to decrypt account credentials" });
      }

      const { listWhatsAppTemplates } = require("../../services/meta/whatsapp.service");
      const templates = await listWhatsAppTemplates(account.wabaId, accessToken);
      
      return res.json({ data: templates });
    } catch (error: any) {
      logger.error("whatsapp.templates.list_routes_failed", { error: error.message });
      return res.status(500).json({ error: error.message });
    }
  },
);

// ─── POST /v1/whatsapp/conversations/:id/template ────────────────────────────
/**
 * Send a specific WhatsApp template to a conversation.
 */
conversationsRoutes.post(
  "/:id/template",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id as number;
      const conversationId = parseInt(req.params.id, 10);
      const { templateName, languageCode, components, textPreview } = req.body;

      if (!templateName || !languageCode) {
        return res.status(400).json({ error: "templateName and languageCode are required" });
      }

      const phoneNumberIds = await getUserPhoneNumberIds(userId);
      const conversation = await getConversationForUser(conversationId, phoneNumberIds);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const account = await prisma.whatsAppAccount.findFirst({
        where: { phoneNumberId: conversation.pageId, userId, isActive: true },
        select: { accessToken: true, phoneNumberId: true },
      });

      if (!account) {
        return res.status(404).json({ error: "WhatsApp account not found" });
      }

      const accessToken = decryptFacebookSecret(account.accessToken);
      const customerPhone = conversation.customerPhone ?? conversation.senderId;

      const { sendWhatsAppTemplate } = require("../../services/meta/whatsapp.service");
      
      // 1. Send via Meta API
      try {
        await sendWhatsAppTemplate(
          customerPhone,
          templateName,
          languageCode,
          components || [],
          account.phoneNumberId,
          accessToken,
        );
      } catch (apiErr: any) {
        logger.error("whatsapp.templates.send_failed", { conversationId, error: apiErr.message });
        return res.status(502).json({ error: "WhatsApp Template API error", detail: apiErr.message });
      }

      // 2. Persist to DB
      // We save the textPreview (what the user saw in the UI) as the content
      const saved = await saveMessage(conversationId, "model", textPreview || `[Template: ${templateName}]`);

      emitToBusiness(conversation.businessProfileId, "new_message", {
        conversationId: conversation.id,
        message: saved,
      });
      emitToConversation(conversation.id, "new_message", {
        message: saved,
      });

      return res.status(201).json({ data: saved });
    } catch (error: any) {
      logger.error("whatsapp.templates.send_route_error", { error: error.message });
      return res.status(500).json({ error: error.message });
    }
  },
);

// ============================================================================
// HITL (Approve / Edit / Send Drafts)
// ============================================================================
conversationsRoutes.put(
  "/:conversationId/messages/:messageId/approve",
  authenticateToken,
  async (req: Request, res: Response): Promise<any> => {
    try {
      const { conversationId, messageId } = req.params;
      const { editedContent } = req.body;
      const userId = (req as any).user.id;

      if (!editedContent) {
        return res.status(400).json({ error: "editedContent is required." });
      }

      // We verify access by loading ALL owned assets for this user (both WA and Messenger).
      const [waAccounts, fbPages] = await Promise.all([
        prisma.whatsAppAccount.findMany({
          where: { userId, isActive: true },
          select: { phoneNumberId: true },
        }),
        prisma.facebookPage.findMany({
          where: { facebookAccount: { userId }, isActive: true },
          select: { pageId: true, pageAccessToken: true, facebookAccount: { select: { accessToken: true } } },
        })
      ]);

      const waPhoneIds = waAccounts.map(a => a.phoneNumberId);
      const fbPageIds = fbPages.map(p => p.pageId);

      const conversation = await prisma.conversation.findFirst({
        where: {
          id: parseInt(conversationId, 10),
          OR: [
            { 
              pageId: { in: waPhoneIds }, 
              OR: [
                { channel: "whatsapp" },
                { channel: null }
              ] 
            },
            { pageId: { in: fbPageIds }, channel: "messenger" }
          ]
        }
      });

      if (!conversation) {
        return res.status(403).json({ error: "Conversation not found or access denied." });
      }

      const message = await prisma.conversationMessage.findUnique({
        where: { id: parseInt(messageId, 10), conversationId: conversation.id }
      });

      if (!message || message.role !== "model" || message.status !== "PENDING_REVIEW") {
        return res.status(400).json({ error: "Message not found or is not a pending AI draft." });
      }

      const isEdited = message.content !== editedContent;

      // 1. Transactionally record the correction and mark send
      await prisma.$transaction(async (tx) => {
        if (isEdited) {
          await tx.aiCorrection.create({
            data: {
              messageId: message.id,
              originalAiText: message.content,
              humanEditedText: editedContent
            }
          });
        }
        await tx.conversationMessage.update({
          where: { id: message.id },
          data: {
            content: editedContent,
            status: isEdited ? "EDITED_AND_SENT" : "SENT"
          }
        });
        
        // Also ensure conversation is open
        if (conversation.status === "RESOLVED") {
          await tx.conversation.update({
            where: { id: conversation.id },
            data: { status: "OPEN" }
          });
        }
      });

      const updatedMsg = await prisma.conversationMessage.findUnique({ where: { id: message.id }});

      // 2. Dispatch via Meta API
      if (conversation.channel === "messenger") {
         const page = fbPages.find(p => p.pageId === conversation.pageId);
         if (!page) throw new Error("Missing Facebook Page Access Token for dispatch.");
         const pageToken = decryptFacebookSecret(page.pageAccessToken);
         await sendMessengerReply(conversation.senderId, editedContent, pageToken);
         logger.info("messenger.hitl.approved", { messageId: message.id });
      } else {
         // Default to WhatsApp
         const waAccount = await prisma.whatsAppAccount.findFirst({ where: { phoneNumberId: conversation.pageId }});
         if (!waAccount) throw new Error("Missing WhatsApp Account for dispatch.");
         const waToken = decryptFacebookSecret(waAccount.accessToken);
         await sendWhatsAppReply(conversation.senderId, editedContent, conversation.pageId, waToken);
         logger.info("whatsapp.hitl.approved", { messageId: message.id });
      }

      // 3. Notify sockets
      emitToBusiness(conversation.businessProfileId, "message_updated", {
        conversationId: conversation.id,
        message: updatedMsg,
      });
      emitToConversation(conversation.id, "new_message", {
        message: updatedMsg,
      });

      return res.status(200).json({ data: updatedMsg });
    } catch (error: any) {
      logger.error("hitl.approve_error", { error: error.message });
      return res.status(500).json({ error: error.message });
    }
  }
);

/** DELETE /v1/meta/conversations/:id/messages/:mid — dismiss a draft */
conversationsRoutes.delete(
  "/:id/messages/:mid",
  authenticateToken,
  async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = (req as any).user.id as number;
      const conversationId = parseInt(req.params.id, 10);
      const messageId = parseInt(req.params.mid, 10);

      // Auth: verify access to conversation and message
      const [waAccounts, fbPages] = await Promise.all([
        prisma.whatsAppAccount.findMany({ where: { userId, isActive: true }, select: { phoneNumberId: true }}),
        prisma.facebookPage.findMany({ where: { facebookAccount: { userId }, isActive: true }, select: { pageId: true }})
      ]);
      
      const phoneIds = waAccounts.map(a => a.phoneNumberId);
      const pageIds = fbPages.map(p => p.pageId);

      const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, pageId: { in: [...phoneIds, ...pageIds] }}
      });

      if (!conversation) return res.status(404).json({ error: "Not found" });

      const msg = await prisma.conversationMessage.findFirst({
        where: { id: messageId, conversationId, status: "PENDING_REVIEW" }
      });

      if (!msg) return res.status(404).json({ error: "Draft not found" });

      await prisma.conversationMessage.delete({ where: { id: messageId } });

      emitToBusiness(conversation.businessProfileId, "message_deleted", {
        conversationId,
        messageId
      });

      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  }
);

// ─── POST /v1/meta/conversations/:id/suggest ──────────────────────────────────
/**
 * Manually trigger the AI to generate a draft suggestion for this conversation.
 * Returns the saved PENDING_REVIEW message.
 */
conversationsRoutes.post(
  "/:id/suggest",
  authenticateToken,
  async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = (req as any).user.id as number;
      const conversationId = parseInt(req.params.id, 10);

      if (isNaN(conversationId)) {
        return res.status(400).json({ error: "Invalid conversation id" });
      }

      // 1. Auth: Verify conversation ownership
      const [waAccounts, fbPages] = await Promise.all([
        prisma.whatsAppAccount.findMany({
          where: { userId, isActive: true },
          select: { phoneNumberId: true },
        }),
        prisma.facebookPage.findMany({
          where: { facebookAccount: { userId }, isActive: true },
          select: { pageId: true },
        })
      ]);

      const waPhoneIds = waAccounts.map(a => a.phoneNumberId);
      const fbPageIds = fbPages.map(p => p.pageId);

      const conversation = await prisma.conversation.findFirst({
        where: {
          id: conversationId,
          pageId: { in: [...waPhoneIds, ...fbPageIds] }
        },
        include: { businessProfile: true }
      });

      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found or access denied." });
      }

      // 2. Fetch history and prepare prompt
      const historyRows = await getConversationHistory(conversation.id);
      if (historyRows.length === 0) {
        return res.status(400).json({ error: "Cannot suggest a reply for an empty conversation." });
      }

      const lastUserMsg = historyRows[historyRows.length - 1];
      if (lastUserMsg?.role === "model") {
        // Technically we can still suggest even if the last message was a model,
        // but it's most common to suggest in response to a user.
        // We'll proceed regardless to allow "Regeneration".
      }

      const historyForPrompt = toPromptMessages(historyRows);
      const historyTurns = historyToLlmTurns(historyForPrompt);

      // 3. Compute Reply
      const reply = await computeBusinessChatReply({
        businessProfile: conversation.businessProfile,
        messageText: lastUserMsg?.content || "",
        historyTurns,
        channel: (conversation.channel as any) || "whatsapp"
      });

      // 4. Save as PENDING_REVIEW (Draft)
      const saved = await prisma.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          role: "model",
          content: reply.content || "",
          status: "PENDING_REVIEW",
          aiReasoning: reply.reasoning,
          handoffCategory: reply.handoffCategory
        }
      });

      // 5. Notify
      emitToBusiness(conversation.businessProfileId, "new_message", {
        conversationId: conversation.id,
        message: saved,
      });
      emitToConversation(conversation.id, "new_message", {
        message: saved,
      });

      return res.status(201).json({ data: saved });
    } catch (error: any) {
      logger.error("meta.suggest_error", { error: error.message });
      return res.status(500).json({ error: error.message });
    }
  }
);

export default conversationsRoutes;
