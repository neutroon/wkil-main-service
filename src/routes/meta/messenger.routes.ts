import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma";
import { enqueueMetaJob } from "../../queues/messenger.queue";
import { logger } from "../../utils/logger";
import { verifyMetaWebhookSignature } from "../../utils/metaWebhook";
import { authenticateToken } from "../../middlewares/auth.middleware";
import {
  listMessengerConversations,
  listConversationMessages,
  getMessengerConversationForUser,
  saveMessage,
} from "../../services/meta/conversation.service";
import { handleMessengerMessage } from "../../services/meta/messenger.service";
import { decryptFacebookSecret } from "../../utils/tokenCrypto";
import { emitToBusiness, emitToConversation } from "../../utils/socket";

const messengerRoutes = Router();

const isDev = process.env.NODE_ENV !== "production";

function isProcessedMessengerTableMissing(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2021") return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("ProcessedMessengerMessage") &&
    msg.includes("does not exist")
  );
}

// ─── Shared Helpers ───────────────────────────────────────────────────────────

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

async function getUserFacebookPageIds(userId: number): Promise<string[]> {
  const pages = await prisma.facebookPage.findMany({
    where: { facebookAccount: { userId }, isActive: true },
    select: { pageId: true },
  });
  return pages.map((p: { pageId: string }) => p.pageId);
}

// ─── API Routes (Authenticated) ───────────────────────────────────────────────

/** List paginated Messenger conversations. */
messengerRoutes.get(
  "/",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id as number;
      const { page, limit } = parsePagination(req.query as Record<string, unknown>);
      const result = await listMessengerConversations(userId, page, limit);
      return res.json(result);
    } catch (error: any) {
      logger.error("messenger.conversations.list_failed", { error: error.message });
      return res.status(500).json({ error: error.message });
    }
  },
);

/** Get messages for a Messenger conversation. */
messengerRoutes.get(
  "/:id/messages",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id as number;
      const conversationId = parseInt(req.params.id, 10);

      const pageIds = await getUserFacebookPageIds(userId);
      const conversation = await getMessengerConversationForUser(conversationId, pageIds);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const { limit } = parsePagination(req.query as Record<string, unknown>, 50);
      const cursor = req.query.cursor ? parseInt(req.query.cursor as string, 10) : undefined;
      const result = await listConversationMessages(conversationId, limit, cursor);

      // Enrich with page name
      const pageInfo = await prisma.facebookPage.findFirst({
        where: { pageId: conversation.pageId },
        select: { pageName: true },
      });

      return res.json({
        conversation: {
          id: conversation.id,
          businessProfileId: conversation.businessProfileId,
          pageId: conversation.pageId,
          pageName: pageInfo?.pageName ?? conversation.pageId,
          senderId: conversation.senderId,
          channel: conversation.channel,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
        },
        ...result,
      });
    } catch (error: any) {
      logger.error("messenger.conversations.messages_failed", { error: error.message });
      return res.status(500).json({ error: error.message });
    }
  },
);

/** Send a reply to a Messenger conversation. */
messengerRoutes.post(
  "/:id/messages",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id as number;
      const conversationId = parseInt(req.params.id, 10);
      const { text } = req.body as { text?: string };

      if (!text?.trim()) {
        return res.status(400).json({ error: "text is required" });
      }

      const pageIds = await getUserFacebookPageIds(userId);
      const conversation = await getMessengerConversationForUser(conversationId, pageIds);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const page = await prisma.facebookPage.findFirst({
        where: { pageId: conversation.pageId, isActive: true },
      });

      if (!page) {
        return res.status(404).json({ error: "Facebook Page not found" });
      }

      const pageAccessToken = decryptFacebookSecret(page.pageAccessToken);
      const trimmedText = text.trim();

      // 1. Send via Graph API FIRST
      const fbRes = await fetch(
        `https://graph.facebook.com/v25.0/me/messages?access_token=${pageAccessToken}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipient: { id: conversation.senderId },
            message: { text: trimmedText },
          }),
        },
      );

      if (!fbRes.ok) {
        const error = await fbRes.json();
        logger.error("messenger.conversations.send_failed", { 
          conversationId, 
          error: JSON.stringify(error) 
        });
        return res.status(502).json({ 
          error: "Messenger API error", 
          detail: error.error?.message ?? "Unknown Messenger error" 
        });
      }

      // 2. Persist ONLY if API call succeeded
      const saved = await saveMessage(conversationId, "agent", trimmedText);

      // Emit real-time updates
      emitToBusiness(conversation.businessProfileId, "new_message", {
        conversationId: conversation.id,
        message: saved,
      });
      emitToConversation(conversation.id, "new_message", {
        message: saved,
      });

      return res.status(201).json({ data: saved });
    } catch (error: any) {
      logger.error("messenger.conversations.send_failed", { error: error.message });
      return res.status(500).json({ error: error.message });
    }
  },
);

// ─── Webhook Routes ───────────────────────────────────────────────────────────

messengerRoutes.get("/webhook", (req: Request, res: Response) => {
  const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (isDev) {
    logger.debug("messenger.webhook.verify_request", {
      mode,
      challengePresent: Boolean(challenge),
    });
  }

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    logger.info("messenger.webhook.verified");
    return res.status(200).send(challenge);
  }

  logger.warn("messenger.webhook.verify_failed");
  return res.status(403).json({ error: "Verification failed" });
});

messengerRoutes.post("/webhook", async (req: Request, res: Response) => {
  res.status(200).send("EVENT_RECEIVED");

  try {
    const rawBody = req.body as Buffer | unknown;
    const signature = req.headers["x-hub-signature-256"] as string | undefined;

    if (
      !verifyMetaWebhookSignature(
        rawBody as Buffer,
        signature,
        process.env.FB_APP_SECRET || "",
      )
    ) {
      logger.error("messenger.webhook.invalid_signature");
      return;
    }

    let body: any;
    try {
      const str = Buffer.isBuffer(rawBody)
        ? rawBody.toString("utf8")
        : JSON.stringify(rawBody);
      body = JSON.parse(str);
    } catch {
      logger.error("messenger.webhook.invalid_json");
      return;
    }

    logger.info("messenger.webhook.event_received");

    for (const entry of body.entry) {
      const pageId = entry.id;

      // 1. Handle Feed changes (Facebook Comments)
      if (Array.isArray(entry.changes)) {
        for (const change of entry.changes) {
          if (change.field === "feed") {
            const value = change.value;
            // PRODUCTION GUARD: Handle only new comment additions.
            // Ignore edits, deletes, and self-comments by the page admin.
            if (value.item === "comment" && value.verb === "add") {
              const senderId = value.from?.id;
              if (senderId === pageId) {
                logger.debug("facebook.webhook.self_comment_ignored", { pageId, commentId: value.comment_id });
                continue;
              }

              const messageText = value.message;
              const commentId = value.comment_id;
              const postId = value.post_id;
              const senderName = value.from?.name;

              if (senderId && messageText && commentId) {
                logger.info("facebook.webhook.comment_enqueued", { pageId, senderId, commentId });
                enqueueMetaJob({
                  type: "FACEBOOK_COMMENT",
                  pageId,
                  senderId,
                  commentId,
                  postId,
                  messageText,
                  senderName,
                });
              }
            }
          }
        }
      }

      // 2. Handle Messaging items (Messenger/Instagram)
      if (Array.isArray(entry.messaging)) {
        for (const event of entry.messaging) {
          const senderId = event.sender?.id;

          // 2a. Handle Typing Indicators from Customer
          if (event.sender_action) {
             const action = event.sender_action; // "typing_on" or "typing_off"
             const conversation = await prisma.conversation.findFirst({
                where: { pageId, senderId, channel: "messenger" },
                select: { id: true, businessProfileId: true }
             });
             if (conversation) {
                emitToBusiness(conversation.businessProfileId, "customer_typing", {
                   conversationId: conversation.id,
                   typing: action === "typing_on"
                });
             }
             continue;
          }

          // 2b. Handle Read Receipts from Customer
          if (event.read) {
             const watermark = event.read.watermark;
             const conversation = await prisma.conversation.findFirst({
                where: { pageId, senderId, channel: "messenger" },
                select: { id: true, businessProfileId: true }
             });
             if (conversation) {
                // Find all model messages in this conversation sent before the watermark
                // and mark them as READ.
                await prisma.conversationMessage.updateMany({
                   where: { 
                      conversationId: conversation.id, 
                      role: "model",
                      status: { not: "READ" },
                      createdAt: { lte: new Date(watermark) }
                   },
                   data: { status: "READ" }
                });

                emitToBusiness(conversation.businessProfileId, "message_status_updated", {
                   conversationId: conversation.id,
                   status: "READ",
                   watermark
                });
             }
             continue;
          }

          // 2c. Handle Message Deliveries
          if (event.delivery) {
             const mids = event.delivery.mids;
             if (Array.isArray(mids)) {
                await prisma.conversationMessage.updateMany({
                   where: { externalId: { in: mids } },
                   data: { status: "DELIVERED" }
                });
                // Emit update (simplification: we'll just emit the event)
             }
             continue;
          }

          // 2d. Handle Inbound Messages
          if (!event.message || event.message.is_echo) continue;

          const messageText = event.message.text;
          const messageMid = event.message.mid;

          if (!senderId || !messageText) continue;

          if (messageMid) {
            try {
              const inserted = await prisma.processedMessengerMessage.createMany({
                data: [{ messageMid }],
                skipDuplicates: true,
              });
              if (inserted.count === 0) {
                logger.debug("messenger.webhook.duplicate_mid_skipped", {
                  messageMid,
                });
                continue;
              }
            } catch (e: unknown) {
              if (isProcessedMessengerTableMissing(e)) {
                logger.warn(
                  "messenger.webhook.idempotency_table_missing_run_prisma_migrate",
                );
              } else {
                throw e;
              }
            }
          }

          logger.info("messenger.webhook.message_enqueued", {
            pageId,
            senderId,
          });

          enqueueMetaJob({
            type: "MESSENGER",
            pageId,
            senderId,
            messageText,
            externalId: messageMid // Pass through the ID
          });
        }
      }
    }
  } catch (error: any) {
    logger.error("messenger.webhook.handler_error", { error: error.message });
  }
});

export default messengerRoutes;
