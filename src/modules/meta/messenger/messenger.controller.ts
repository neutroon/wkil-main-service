import { Request, Response } from "express";
import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import {
  listMessengerConversations,
  listConversationMessages,
  getMessengerConversationForUser,
  saveMessage,
} from "../core/conversation.service";
import { sendMessengerMedia } from "./messenger.service";
import { uploadMessengerMedia } from "../core/metaUpload.service";
import { AppError } from "@middlewares/errorHandler.middleware";
import { env } from "@config/env";
import { verifyMetaWebhookSignature } from "../core/metaWebhook";
import { enqueueInboundMetaEvent, enqueueMetaJob } from "../core/meta.queue";
import { isKnownFacebookPage } from "../core/webhookCache.service";

const isDev = env.NODE_ENV !== "production";

export class MessengerController {
  /**
   * GET /v1/messenger/webhook
   */
  async verifyWebhook(req: Request, res: Response) {
    const VERIFY_TOKEN = env.MESSENGER_VERIFY_TOKEN;
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (isDev) {
      logger.debug("messenger.webhook.verify_request", { mode, challengePresent: Boolean(challenge) });
    }

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      logger.info("messenger.webhook.verified");
      return res.status(200).send(challenge);
    }

    logger.warn("messenger.webhook.verify_failed");
    return res.status(403).json({ error: "Verification failed" });
  }

  /**
   * POST /v1/messenger/webhook
   */
  async handleWebhook(req: Request, res: Response) {
    res.status(200).send("EVENT_RECEIVED");

    try {
      const rawBody = req.body as Buffer | unknown;
      const signature = req.headers["x-hub-signature-256"] as string | undefined;

      if (!verifyMetaWebhookSignature(rawBody as Buffer, signature, env.FB_APP_SECRET || "")) {
        logger.error("messenger.webhook.invalid_signature");
        return;
      }

      let body: any;
      try {
        const str = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : JSON.stringify(rawBody);
        body = JSON.parse(str);
      } catch {
        logger.error("messenger.webhook.invalid_json");
        return;
      }

      for (const entry of body.entry) {
        const pageId = entry.id;
        const isKnown = await isKnownFacebookPage(pageId);
        if (!isKnown) {
          logger.warn("messenger.webhook.unknown_page_discarded", { pageId });
          continue;
        }

        // 1. Feed changes
        if (Array.isArray(entry.changes)) {
          for (const change of entry.changes) {
            if (change.field === "feed") {
              const value = change.value;
              if (value.item === "comment" && value.verb === "add") {
                const senderId = value.from?.id;
                const isFromBusiness = senderId === pageId;
                const messageText = value.message;
                const commentId = value.id || value.comment_id;
                const postId = value.post_id;
                const parentId = value.parent_id;
                const senderName = value.from?.name;

                if (senderId && messageText && commentId) {
                  enqueueInboundMetaEvent({
                    platform: "facebook_comment",
                    eventId: commentId,
                    payload: {
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
                    } as any,
                  });
                }
              }
            }
          }
        }

        // 2. Messaging items
        if (Array.isArray(entry.messaging)) {
          for (const event of entry.messaging) {
            const senderId = event.sender?.id;

            if (event.sender_action) {
               enqueueMetaJob({
                 platform: "messenger",
                 type: "typing_indicator",
                 identifier: pageId,
                 senderId,
                 isTyping: event.sender_action === "typing_on"
               } as any);
               continue;
            }

            if (event.read) {
               enqueueMetaJob({
                 platform: "messenger",
                 type: "status_update",
                 identifier: pageId,
                 senderId,
                 statusEvent: "READ",
                 watermark: event.read.watermark
               } as any);
               continue;
            }

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

            if (!event.message) continue;

            const isFromBusiness = event.message.is_echo === true;
            const messageText = event.message.text;
            const messageMid = event.message.mid;
            const attachments = event.message.attachments;
            const actualCustomerId = isFromBusiness ? event.recipient?.id : senderId;

            if (!actualCustomerId) continue;

            let msgType = "text";
            let mediaId: string | undefined;
            let mediaMetadata: any = {};

            if (Array.isArray(attachments) && attachments.length > 0) {
              const att = attachments[0];
              msgType = att.type;
              mediaId = att.payload?.sticker_id || att.payload?.url?.split("?")[0].split("/").pop(); 
              mediaMetadata = { url: att.payload?.url, title: att.title };
              if (msgType === "audio" && att.payload?.is_voice) msgType = "voice";
            }

            if (!senderId) continue;
            if (msgType === "text" && !messageText) continue;
            if (msgType !== "text" && !attachments) continue;

            enqueueInboundMetaEvent({
              platform: "messenger",
              eventId: messageMid,
              payload: {
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
              } as any,
            });
          }
        }
      }
    } catch (error: any) {
      logger.error("messenger.webhook.handler_error", { error: error.message });
    }
  }

  /**
   * GET /v1/messenger/
   */
  async listConversations(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const { page, limit, status, channel: channelParam } = req.query as any;
    const channel = channelParam === "facebook_comment" ? "facebook_comment" : "messenger";
    
    const result = await listMessengerConversations(userId, page, limit, channel, status);
    return res.json(result);
  }

  /**
   * GET /v1/messenger/:id/messages
   */
  async listMessages(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;
    const { limit, cursor } = req.query as any;

    const pageIds = await this.getUserFacebookPageIds(userId);
    const conversation = await getMessengerConversationForUser(conversationId, pageIds);
    if (!conversation) throw new AppError("Conversation not found", 404);

    const result = await listConversationMessages(conversationId, limit, cursor);

    const pageInfo = await prisma.facebookPage.findFirst({
      where: { pageId: conversation.pageId },
      select: { pageName: true },
    });

    return res.json({
      conversation: { ...conversation, pageName: pageInfo?.pageName ?? conversation.pageId },
      ...result,
    });
  }

  /**
   * POST /v1/messenger/conversations/:id/messages
   */
  async sendManualReply(req: Request, res: Response) {
    const { id: conversationId } = req.params as any;
    const { message: text } = req.body;

    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) throw new AppError("Conversation not found", 404);

    const page = await prisma.facebookPage.findFirst({ where: { pageId: conversation.pageId, isActive: true } });
    if (!page) throw new AppError("Facebook Page not found", 404);

    const pageAccessToken = decryptFacebookSecret(page.pageAccessToken);
    const trimmedText = text.trim();
    const isPrivateRequest = req.body.isPrivate === true;

    let fbData: any;
    if (conversation.channel === "facebook_comment") {
      if (!conversation.externalId) throw new AppError("Missing Comment ID", 400);

      if (isPrivateRequest) {
        const { sendPrivateReply } = await import("../facebook/facebook.service");
        fbData = await sendPrivateReply({
          commentId: conversation.externalId,
          message: trimmedText,
          accessToken: pageAccessToken,
          pageId: page.pageId,
          businessProfileId: page.businessProfileId!
        });
      } else {
        const { replyToComment } = await import("../facebook/facebook.service");
        fbData = await replyToComment({
          commentId: conversation.externalId,
          message: trimmedText,
          accessToken: pageAccessToken,
          pageId: page.pageId,
        });
      }
    } else {
      const { sendMessengerReply } = await import("./messenger.service");
      fbData = await sendMessengerReply(conversation.senderId, trimmedText, pageAccessToken);
    }

    const mid = fbData.id || fbData.message_id;
    const saved = await saveMessage(conversationId, "agent", trimmedText, {
      externalId: mid?.toString(),
      status: "SENT",
      isPrivate: isPrivateRequest,
      origin: conversation.channel === "facebook_comment" ? "facebook_comment_reply" : undefined
    });

    if (conversation.channel === "facebook_comment" && isPrivateRequest && mid && mid !== "ALREADY_REPLIED") {
      try {
        const { mirrorCommentReplyToMessenger } = await import("../core/metaDelivery.service");
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
      } catch (err: any) {
        logger.warn("messenger.manual_reply.mirror_failed", { error: err.message });
      }
    }

    return res.status(201).json({ data: saved });
  }

  /**
   * POST /v1/messenger/conversations/:id/media
   */
  async uploadAndSendMedia(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;
    const file = req.file;
    const messageText = req.body.messageText || "";

    if (!file) throw new AppError("No file uploaded", 400);

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { businessProfile: true }
    });

    if (!conversation || conversation.businessProfile.userId !== userId) {
      throw new AppError("Access denied", 403);
    }

    const page = await prisma.facebookPage.findFirst({
      where: { pageId: conversation.pageId, isActive: true },
      select: { pageAccessToken: true }
    });

    if (!page) throw new AppError("Facebook Page not found", 404);

    const pageAccessToken = decryptFacebookSecret(page.pageAccessToken);
    const attachmentId = await uploadMessengerMedia(conversation.pageId, pageAccessToken, file.buffer, file.originalname, file.mimetype);

    const type = file.mimetype.startsWith("image") ? "image" : file.mimetype.startsWith("video") ? "video" : file.mimetype.startsWith("audio") ? "audio" : "file";
    const platformRes = await sendMessengerMedia(conversation.senderId, attachmentId, type as any, pageAccessToken);

    const mid = (platformRes as any)?.message_id;
    const sentMsg = await saveMessage(conversationId, "agent", messageText, {
      externalId: mid,
      type,
      mediaId: attachmentId,
      mediaMetadata: { mimeType: file.mimetype, filename: file.originalname, size: file.size }
    });

    return res.json(sentMsg);
  }

  private async getUserFacebookPageIds(userId: number): Promise<string[]> {
    const profiles = await prisma.businessProfile.findMany({ where: { userId }, select: { id: true } });
    const profileIds = profiles.map((p) => p.id);
    if (profileIds.length === 0) return [];

    const pages = await prisma.facebookPage.findMany({
      where: { businessProfileId: { in: profileIds }, isActive: true },
      select: { pageId: true },
    });

    return pages.map((p) => p.pageId);
  }
}

export const messengerController = new MessengerController();









