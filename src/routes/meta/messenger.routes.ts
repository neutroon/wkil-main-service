import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma";
import { enqueueMessengerJob } from "../../queues/messenger.queue";
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

      const { page, limit } = parsePagination(req.query as Record<string, unknown>, 50);
      const result = await listConversationMessages(conversationId, page, limit);

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

      // Send via Graph API
      const fbRes = await fetch(
        `https://graph.facebook.com/v25.0/me/messages?access_token=${pageAccessToken}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipient: { id: conversation.senderId },
            message: { text: text.trim() },
          }),
        },
      );

      if (!fbRes.ok) {
        const error = await fbRes.json();
        throw new Error(`Messenger API error: ${JSON.stringify(error)}`);
      }

      const saved = await saveMessage(conversationId, "model", text.trim());

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

    if (body.object !== "page" || !Array.isArray(body.entry)) return;

    for (const entry of body.entry) {
      const pageId = entry.id;
      if (!pageId || !Array.isArray(entry.messaging)) continue;

      for (const event of entry.messaging) {
        if (!event.message || event.message.is_echo) continue;

        const senderId = event.sender?.id;
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

        enqueueMessengerJob({ pageId, senderId, messageText });
      }
    }
  } catch (error: any) {
    logger.error("messenger.webhook.handler_error", { error: error.message });
  }
});

export default messengerRoutes;
