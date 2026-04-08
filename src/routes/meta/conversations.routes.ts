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
import { decryptFacebookSecret } from "../../utils/tokenCrypto";
import { emitToBusiness, emitToConversation } from "../../utils/socket";

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

      // Send via WhatsApp Cloud API
      try {
        await sendWhatsAppReply(customerPhone, text.trim(), account.phoneNumberId, accessToken);
      } catch (apiErr: any) {
        logger.error("whatsapp.conversations.send_failed", {
          conversationId,
          error: apiErr.message,
        });
        return res.status(502).json({ error: "WhatsApp Cloud API error", detail: apiErr.message });
      }

      // Persist the outbound message
      const saved = await saveMessage(conversationId, "model", text.trim());

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
        preview: text.trim().slice(0, 80),
      });

      return res.status(201).json({ data: saved });
    } catch (error: any) {
      logger.error("whatsapp.conversations.send_error", { error: error.message });
      return res.status(500).json({ error: error.message });
    }
  },
);

export default conversationsRoutes;
