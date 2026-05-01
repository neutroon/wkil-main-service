import { Router, Request, Response } from "express";

import prisma from "../../config/prisma";
import { enqueueMetaJob } from "../../queues/meta.queue";
import { logger } from "../../utils/logger";
import { verifyMetaWebhookSignature } from "../../utils/metaWebhook";
import { redisClient } from "../../config/redis";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { isKnownFacebookPage } from "../../services/meta/webhookCache.service";
import {
  listMessengerConversations,
  listConversationMessages,
  getMessengerConversationForUser,
  saveMessage,
} from "../../services/meta/conversation.service";
import { sendMessengerMedia } from "../../services/meta/messenger.service";
import { AppError } from "../../middlewares/errorHandler.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { sendMessengerReplySchema } from "../../validations/meta.validation";
import { paginationSchema, idPaginationSchema, idParamSchema } from "../../validations/shared.validation";
import { decryptFacebookSecret } from "../../utils/tokenCrypto";
import { uploadMessengerMedia } from "../../services/meta/metaUpload.service";
import multer from "multer";
import { env } from "../../config/env";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } }); // 16MB limit

const messengerRoutes = Router();

/**
 * POST /v1/messenger/conversations/:id/media
 */
messengerRoutes.post("/conversations/:id/media", authenticateToken, upload.single("file"), validate(idParamSchema), async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const { id: conversationId } = req.params as any;
    const file = req.file;
    const messageText = req.body.messageText || "";

    if (!file) throw new AppError("No file uploaded", 400);

    // 1. Ownership Check
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { businessProfile: true }
    });

    if (!conversation || conversation.businessProfile.userId !== userId) {
      throw new AppError("Access denied or conversation not found", 403);
    }

    // 2. Token Resolution
    const page = await prisma.facebookPage.findFirst({
      where: { pageId: conversation.pageId, isActive: true },
      select: { pageAccessToken: true }
    });

    if (!page) throw new AppError("Facebook Page not found", 404);

    const pageAccessToken = decryptFacebookSecret(page.pageAccessToken);

    // 3. Upload to Meta
    const attachmentId = await uploadMessengerMedia(
      conversation.pageId,
      pageAccessToken,
      file.buffer,
      file.originalname,
      file.mimetype
    );

    // 4. Send via Meta
    const type = file.mimetype.startsWith("image") ? "image" : file.mimetype.startsWith("video") ? "video" : file.mimetype.startsWith("audio") ? "audio" : "file";
    const platformRes = await sendMessengerMedia(
      conversation.senderId,
      attachmentId,
      type as any,
      pageAccessToken
    );

    const mid = (platformRes as any)?.message_id;

    // 5. Save to DB
    const sentMsg = await saveMessage(conversationId, "agent", messageText, {
      externalId: mid,
      type,
      mediaId: attachmentId,
      mediaMetadata: { 
        mimeType: file.mimetype, 
        filename: file.originalname, 
        size: file.size 
      }
    });

    return res.json(sentMsg);
  }
);

const isDev = env.NODE_ENV !== "production";



// ─── Shared Helpers ───────────────────────────────────────────────────────────

async function getUserFacebookPageIds(userId: number): Promise<string[]> {
  // 1. Resolve all BusinessProfiles owned by this user
  const profiles = await prisma.businessProfile.findMany({
    where: { userId },
    select: { id: true },
  });
  const profileIds = profiles.map((p) => p.id);

  if (profileIds.length === 0) {
    return [];
  }

  // 2. Resolve all Facebook pages linked to these profiles
  const pages = await prisma.facebookPage.findMany({
    where: { businessProfileId: { in: profileIds }, isActive: true },
    select: { pageId: true },
  });

  return pages.map((p) => p.pageId);
}

// ─── API Routes (Authenticated) ───────────────────────────────────────────────

messengerRoutes.get("/", authenticateToken, validate(paginationSchema), async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const { page, limit, channel: channelParam } = req.query as any;
  const channel = channelParam === "facebook_comment" ? "facebook_comment" : "messenger";
  
  const result = await listMessengerConversations(userId, page, limit, channel);
  return res.json(result);
});

messengerRoutes.get("/:id/messages", authenticateToken, validate(idPaginationSchema), async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const { id: conversationId } = req.params as any;
  const { limit, cursor } = req.query as any;

  const pageIds = await getUserFacebookPageIds(userId);
  const conversation = await getMessengerConversationForUser(conversationId, pageIds);
  if (!conversation) throw new AppError("Conversation not found", 404);

  const result = await listConversationMessages(conversationId, limit, cursor);

  const pageInfo = await prisma.facebookPage.findFirst({
    where: { pageId: conversation.pageId },
    select: { pageName: true },
  });

  return res.json({
    conversation: {
      ...conversation,
      pageName: pageInfo?.pageName ?? conversation.pageId,
    },
    ...result,
  });
});

/** Send a reply to a Messenger conversation. */
messengerRoutes.post(
  "/conversations/:id/messages",
  authenticateToken,
  validate(idParamSchema),
  validate(sendMessengerReplySchema),
  async (req: Request, res: Response) => {

    const { id: conversationId } = req.params as any;
    const { message: text } = req.body;

    // 1. Context Resolution
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
    });

    if (!conversation) throw new AppError("Conversation not found", 404);

    const page = await prisma.facebookPage.findFirst({
      where: { pageId: conversation.pageId, isActive: true },
    });

    if (!page) throw new AppError("Facebook Page not found", 404);

    const pageAccessToken = decryptFacebookSecret(page.pageAccessToken);
    const trimmedText = text.trim();

    // ── ELITE TIER: Hardened Delivery via Service Layer ──
    let fbData: any;
    const isPrivateRequest = req.body.isPrivate === true;

    if (conversation.channel === "facebook_comment") {
      if (!conversation.externalId) {
        throw new AppError("The Facebook Comment ID for this thread was not correctly synced.", 400);
      }

      if (isPrivateRequest) {
        const { sendPrivateReply } = await import("../../services/meta/facebook.service");
        fbData = await sendPrivateReply({
          commentId: conversation.externalId,
          message: trimmedText,
          accessToken: pageAccessToken,
          pageId: page.pageId,
          businessProfileId: page.businessProfileId!
        });
      } else {
        const { replyToComment } = await import("../../services/meta/facebook.service");
        fbData = await replyToComment({
          commentId: conversation.externalId,
          message: trimmedText,
          accessToken: pageAccessToken,
          pageId: page.pageId,
        });
      }
    } else {
      const { sendMessengerReply } = await import("../../services/meta/messenger.service");
      fbData = await sendMessengerReply(conversation.senderId, trimmedText, pageAccessToken);
    }

    // 2. Persist locally & Emit
    const mid = fbData.id || fbData.message_id;
    const saved = await saveMessage(conversationId, "agent", trimmedText, {
      externalId: mid?.toString(),
      status: "SENT",
      isPrivate: isPrivateRequest,
      origin: conversation.channel === "facebook_comment" ? "facebook_comment_reply" : undefined
    });

    // 3. Selective Mirroring for Private Replies to Comments
    if (conversation.channel === "facebook_comment" && isPrivateRequest && mid && mid !== "ALREADY_REPLIED") {
      try {
        const { mirrorCommentReplyToMessenger } = await import("../../services/meta/metaDelivery.service");
        await mirrorCommentReplyToMessenger({
          pageId: page.pageId,
          senderId: conversation.senderId,
          businessProfileId: page.businessProfileId!,
          messageId: mid.toString(),
          content: trimmedText,
          postId: conversation.postId ?? undefined,
          commentId: conversation.externalId ?? undefined,
          role: "agent"
        });
      } catch (mirrorErr: any) {
        logger.warn("messenger.manual_reply.mirror_failed_soft", { error: mirrorErr.message });
      }
    } else if (mid === "ALREADY_REPLIED") {
      const { syncMessageStatus } = await import("../../services/meta/metaDelivery.service");
      await syncMessageStatus(saved.id, conversation.businessProfileId, conversation.id, {
        status: "FAILED"
      });
    }

    return res.status(201).json({ data: saved });
  }
);

// ─── Webhook Routes ───────────────────────────────────────────────────────────

messengerRoutes.get("/webhook", (req: Request, res: Response) => {
  const VERIFY_TOKEN = env.MESSENGER_VERIFY_TOKEN;
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
  logger.info(">>> RAW WEBHOOK ENDPOINT HIT <<<", { 
    hasSignature: Boolean(req.headers["x-hub-signature-256"])
  });
  res.status(200).send("EVENT_RECEIVED");

  try {
    const rawBody = req.body as Buffer | unknown;
    const signature = req.headers["x-hub-signature-256"] as string | undefined;

    if (
      !verifyMetaWebhookSignature(
        rawBody as Buffer,
        signature,
        env.FB_APP_SECRET || "",
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

      // ── GATE: Verify this page is connected to an active business profile ──
      // This is the most efficient place to check: once per entry, before any job
      // is enqueued. Unknown pages are discarded silently here — Mission Control
      // stays completely clean, and no jobs are ever wasted.
      const isKnown = await isKnownFacebookPage(pageId);
      if (!isKnown) {
        logger.warn("messenger.webhook.unknown_page_discarded", {
          pageId,
          reason: "Page is not connected to any active business profile.",
        });
        continue; // Skip this entire entry — no jobs enqueued
      }

      // 1. Handle Feed changes (Facebook Comments)
      if (Array.isArray(entry.changes)) {
        for (const change of entry.changes) {
          if (change.field === "feed") {
            const value = change.value;
            // PRODUCTION GUARD: Handle only new comment additions.
            // Ignore edits, deletes, and self-comments by the page admin.
            if (value.item === "comment" && value.verb === "add") {
              const senderId = value.from?.id;
              const isFromBusiness = senderId === pageId;
              
              if (isFromBusiness) {
                logger.info("facebook.webhook.self_comment_captured_for_mirroring", { pageId, commentId: value.id });
              }

              const messageText = value.message;
              const commentId = value.id || value.comment_id;
              const postId = value.post_id;
              const parentId = value.parent_id; // NEW: Deep thread awareness
              const senderName = value.from?.name;

              if (senderId && messageText && commentId) {
                // IDEMPOTENCY GUARD: Prevent duplicate processing of the same comment
                const isNew = await redisClient.set(`webhook:dedup:fbcomment:${commentId}`, "1", "EX", 86400, "NX");
                if (!isNew) {
                  logger.debug("facebook.webhook.duplicate_comment_skipped", { commentId });
                  continue;
                }

                logger.info("facebook.webhook.comment_enqueued", { pageId, senderId, commentId });
                enqueueMetaJob({
                  platform: "messenger",
                  type: "FACEBOOK_COMMENT",
                  pageId,
                  identifier: pageId,
                  senderId,
                  commentId,
                  postId,
                  parentId,
                  messageText,
                  senderName,
                  isFromBusiness,
                } as any);
              } else {

                logger.warn("facebook.webhook.comment_skipped_missing_data", { 
                  pageId, 
                  hasSender: !!senderId, 
                  hasMessage: !!messageText, 
                  hasCommentId: !!commentId,
                  isImageOnly: !messageText
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
             enqueueMetaJob({
               platform: "messenger",
               type: "typing_indicator",
               identifier: pageId,
               senderId,
               isTyping: action === "typing_on"
             } as any);
             continue;
          }

          // 2b. Handle Read Receipts from Customer
          if (event.read) {
             const watermark = event.read.watermark;
             enqueueMetaJob({
               platform: "messenger",
               type: "status_update",
               identifier: pageId,
               senderId,
               statusEvent: "READ",
               watermark
             } as any);
             continue;
          }

          // 2c. Handle Message Deliveries
          if (event.delivery) {
             const mids = event.delivery.mids;
             if (Array.isArray(mids) && mids.length > 0) {
               enqueueMetaJob({
                 platform: "messenger",
                 type: "status_update",
                 identifier: pageId,
                 senderId,
                 statusEvent: "DELIVERED",
                 mids
               } as any);
             }
             continue;
          }

          // 2d. Handle Inbound & Mirrored Messages (Echoes)
          if (!event.message) continue;

          const isFromBusiness = event.message.is_echo === true;
          const messageText = event.message.text;
          const messageMid = event.message.mid;
          const attachments = event.message.attachments;
          
          // For echoes, the 'sender' is the Page and 'recipient' is the Customer.
          // We need to map this to the customer's conversation ID.
          const actualCustomerId = isFromBusiness ? event.recipient?.id : senderId;

          if (isFromBusiness) {
            logger.info("messenger.webhook.echo_detected", { 
              pageId, 
              recipientId: event.recipient?.id,
              mid: messageMid 
            });
          }

          if (!actualCustomerId) {
            logger.warn("messenger.webhook.missing_customer_id", { messageMid, isFromBusiness });
            continue;
          }

          let msgType = "text";
          let mediaId: string | undefined;
          let mediaMetadata: any = {};

          if (Array.isArray(attachments) && attachments.length > 0) {
            const att = attachments[0];
            msgType = att.type; // "image", "video", "audio", "file"
            
            // Meta usually provides a 'payload.url' for temporary access, 
            // but for production robustness, we should use the media_id if available.
            // Messenger doesn't always provide media_id in the webhook.
            // If media_id is missing, we store the temporary URL as a fallback in metadata.
            mediaId = att.payload?.sticker_id || att.payload?.url?.split("?")[0].split("/").pop(); 
            // NOTE: Messenger media IDs are tricky in webhooks. 
            // For now, we'll store the URL as mediaId or payload.url.
            mediaMetadata = { url: att.payload?.url, title: att.title };
            
            if (msgType === "audio" && att.payload?.is_voice) {
              msgType = "voice";
            }
          }

          if (!senderId) continue;
          if (msgType === "text" && !messageText) continue;
          if (msgType !== "text" && !attachments) continue;

          if (messageMid) {
            const isNew = await redisClient.set(`webhook:dedup:messenger:${messageMid}`, "1", "EX", 86400, "NX");
            if (!isNew) {
              logger.debug("messenger.webhook.duplicate_mid_skipped", { messageMid });
              continue;
            }
          }

          logger.info("messenger.webhook.message_enqueued", {
            pageId,
            senderId,
          });

          enqueueMetaJob({
            platform: "messenger",
            type: msgType,
            pageId,
            identifier: pageId,
            senderId: actualCustomerId,
            messageText,
            externalId: messageMid,
            msgType,
            mediaId: mediaId?.toString(),
            mediaMetadata,
            isFromBusiness,
          } as any);
        }
      }
    }
  } catch (error: any) {
    logger.error("messenger.webhook.handler_error", { error: error.message });
  }
});

export default messengerRoutes;
