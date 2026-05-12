import { Request, Response } from "express";
import { randomUUID } from "crypto";
import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { encryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { cache } from "@utils/cache";
import { env } from "@config/env";
import { z } from "zod";
import { AppError } from "@middlewares/errorHandler.middleware";
import { enqueueInboundMetaEvent, enqueueMetaJob } from "../core/meta.queue";
import { verifyMetaWebhookSignature } from "../core/metaWebhook";
import {
  exchangeCodeForToken,
  discoverWabaAccounts,
  subscribeWebhook,
  unsubscribeWebhook,
  saveWhatsAppAccount,
  adminTransferAccount,
} from "./whatsappOauth.service";
import {
  listWhatsAppConversations,
  listConversationMessages,
  saveMessage,
} from "../core/conversation.service";
import {
  sendWhatsAppReply,
  sendWhatsAppTemplate,
  listWhatsAppTemplates,
} from "./whatsapp.service";
import { uploadWhatsAppMedia } from "../core/metaUpload.service";
import { sendWhatsAppMedia } from "./whatsapp.service";
import { invalidateWhatsAppAccountCache } from "../core/webhookCache.service";
import { getAuthorizedConversation } from "../../inbox/inbox.routes";

const isDev = env.NODE_ENV !== "production";
const OAUTH_EXCHANGE_REF_TTL_SEC = 10 * 60; // 10 minutes

export class WhatsAppController {
  /**
   * GET /v1/whatsapp/webhook
   * Meta webhook verification
   */
  async verifyWebhook(req: Request, res: Response) {
    const VERIFY_TOKEN = env.WHATSAPP_VERIFY_TOKEN;
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (isDev) {
      logger.debug("whatsapp.webhook.verify_request", {
        mode,
        challengePresent: Boolean(challenge),
      });
    }

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      logger.info("whatsapp.webhook.verified");
      return res.status(200).send(challenge);
    }

    logger.warn("whatsapp.webhook.verify_failed");
    return res.status(403).json({ error: "Verification failed" });
  }

  /**
   * POST /v1/whatsapp/webhook
   * Handle incoming Meta events
   */
  async handleWebhook(req: Request, res: Response) {
    // Always ACK first
    res.status(200).send("EVENT_RECEIVED");

    try {
      const rawBody = req.body as Buffer | unknown;
      const signature = req.headers["x-hub-signature-256"] as string | undefined;

      if (!verifyMetaWebhookSignature(rawBody as Buffer, signature, env.FB_APP_SECRET)) {
        logger.error("whatsapp.webhook.invalid_signature");
        return;
      }

      let body: any;
      try {
        const str = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : JSON.stringify(rawBody);
        body = JSON.parse(str);
      } catch {
        logger.error("whatsapp.webhook.invalid_json");
        return;
      }

      if (body.object !== "whatsapp_business_account" || !Array.isArray(body.entry)) return;

      for (const entry of body.entry) {
        if (!Array.isArray(entry.changes)) continue;

        for (const change of entry.changes) {
          if (change.field !== "messages" && change.field !== "smb_message_echoes" && change.field !== "message_echoes") continue;

          const value = change.value;
          const phoneNumberId = value?.metadata?.phone_number_id;
          const messages = value?.messages || (value as any)?.message_echoes;
          const contacts = value?.contacts;
          const statuses = (value as any)?.statuses;

          // 1. Handle Status Updates
          if (Array.isArray(statuses)) {
            for (const status of statuses) {
              const { id: wamid, status: newStatus } = status;
              enqueueMetaJob({
                platform: "whatsapp",
                type: "status_update",
                externalId: wamid,
                statusEvent: newStatus.toUpperCase()
              } as any);
            }
          }

          // 2. Handle Inbound Messages
          const customerName = (Array.isArray(contacts) && contacts[0]?.profile?.name) || undefined;
          if (!phoneNumberId || !Array.isArray(messages)) continue;

          const account = await prisma.whatsAppAccount.findFirst({
            where: { phoneNumberId, isActive: true, businessProfileId: { not: null } }
          });

          if (!account) {
            logger.warn("whatsapp.webhook.unroutable_account_discarded", { phoneNumberId });
            continue;
          }

          const businessDigits = account.displayPhoneNumber.replace(/\D/g, "");

          for (const msgData of messages) {
            const msg = msgData as any;
            const wamid = msg.id;
            const from = msg.from;
            const type = msg.type;
            
            let messageText = msg.text?.body;
            let mediaId: string | undefined;
            let mediaMetadata: any = {};

            if (type === "image") {
              mediaId = msg.image?.id;
              messageText = msg.image?.caption || "";
              mediaMetadata = { mimeType: msg.image?.mime_type, sha256: msg.image?.sha256 };
            } else if (type === "video") {
              mediaId = msg.video?.id;
              messageText = msg.video?.caption || "";
              mediaMetadata = { mimeType: msg.video?.mime_type, sha256: msg.video?.sha256 };
            } else if (type === "audio" || type === "voice") {
              const audioData = (msg as any).audio || (msg as any).voice;
              mediaId = audioData?.id;
              mediaMetadata = { mimeType: audioData?.mime_type, duration: audioData?.duration };
            } else if (type === "document") {
              mediaId = msg.document?.id;
              messageText = msg.document?.caption || msg.document?.filename || "";
              mediaMetadata = { mimeType: msg.document?.mime_type, filename: msg.document?.filename };
            }

            if (!wamid || !from) continue;
            if (type === "text" && !messageText) continue;
            if (type !== "text" && !mediaId) continue;

            const fromDigits = from.replace(/\D/g, "");
            const isFromBusiness = fromDigits === businessDigits;
            const actualCustomerId = isFromBusiness ? msg.to : from;

            if (!actualCustomerId) continue;

            enqueueInboundMetaEvent({
              platform: "whatsapp",
              eventId: wamid,
              payload: {
                platform: "whatsapp",
                phoneNumberId,
                identifier: phoneNumberId,
                businessProfileId: account.businessProfileId,
                from,
                senderId: actualCustomerId,
                messageText,
                wamid,
                externalId: wamid,
                customerName,
                type,
                isFromBusiness,
              } as any,
            });
          }
        }
      }
    } catch (error: any) {
      logger.error("whatsapp.webhook.handler_error", { error: error.message });
    }
  }

  /**
   * GET /v1/whatsapp/oauth/phone-numbers
   */
  async oauthPreview(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const { code } = req.query;
    const redirectUri = typeof req.query.redirectUri === "string" ? req.query.redirectUri : undefined;
    const accessToken = await exchangeCodeForToken(code as string, redirectUri);
    const accounts = await discoverWabaAccounts(accessToken);
    const exchangeRef = randomUUID();
    
    await cache.set(`wa:oauth:ref:${exchangeRef}`, { userId, accessToken }, OAUTH_EXCHANGE_REF_TTL_SEC);
    return res.json({ data: accounts, exchangeRef });
  }

  /**
   * POST /v1/whatsapp/oauth
   */
  async oauthConnect(req: Request, res: Response) {
    const userId = (req as any).user.id;
    const { code, phoneNumberId, businessProfileId, redirectUri, exchangeRef, connectionMode } = req.body;

    if (!phoneNumberId || (!code && !exchangeRef)) {
      throw new AppError("phoneNumberId is required and either code or exchangeRef must be provided", 400);
    }

    const resolvedConnectionMode: "BUSINESS_API" | "COEXISTENCE" = connectionMode === "BUSINESS_API" ? "BUSINESS_API" : "COEXISTENCE";

    let accessToken: string | undefined;
    if (exchangeRef && typeof exchangeRef === "string") {
      const cached = await cache.get<{ userId: number; accessToken: string }>(`wa:oauth:ref:${exchangeRef}`);
      if (cached && cached.userId === userId) {
        accessToken = cached.accessToken;
        await cache.delete(`wa:oauth:ref:${exchangeRef}`);
      }
    }

    if (!accessToken) {
      accessToken = await exchangeCodeForToken(code as string, redirectUri as string);
    }

    const accounts = await discoverWabaAccounts(accessToken);
    let wabaId: string | undefined;
    let displayPhoneNumber: string | undefined;

    for (const waba of accounts) {
      const phone = waba.phone_numbers.find((p) => p.id === phoneNumberId);
      if (phone) {
        wabaId = waba.id;
        displayPhoneNumber = phone.display_phone_number;
        break;
      }
    }

    if (!wabaId || !displayPhoneNumber) {
      throw new AppError(`Phone number ${phoneNumberId} not found.`, 404);
    }

    await subscribeWebhook(wabaId, accessToken);
    const account = await saveWhatsAppAccount({
      userId,
      wabaId,
      phoneNumberId,
      displayPhoneNumber,
      accessToken,
      connectionMode: resolvedConnectionMode,
      businessProfileId: businessProfileId ? z.coerce.number().int().positive().parse(businessProfileId) : undefined,
    });

    return res.status(201).json({ success: true, account });
  }

  /**
   * GET /v1/whatsapp/accounts
   */
  async listAccounts(req: Request, res: Response) {
    const userId = (req as any).user.id;
    const accounts = await prisma.whatsAppAccount.findMany({
      where: { userId, isActive: true },
      select: {
        id: true,
        phoneNumberId: true,
        displayPhoneNumber: true,
        wabaId: true,
        businessProfileId: true,
        connectionMode: true,
        isActive: true,
        isTokenValid: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return res.json({ data: accounts });
  }

  /**
   * POST /v1/whatsapp/conversations/:id/messages
   */
  async sendManualReply(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;
    const { message: text } = req.body;

    const conversation = await getAuthorizedConversation(userId, conversationId);

    const account = await prisma.whatsAppAccount.findFirst({
      where: { phoneNumberId: conversation.pageId, userId, isActive: true },
      select: { accessToken: true, phoneNumberId: true },
    });

    if (!account) throw new AppError("WhatsApp account not found", 404);

    const accessToken = decryptFacebookSecret(account.accessToken);
    const customerPhone = conversation.customerPhone ?? conversation.senderId;
    const trimmedText = text.trim();

    const platformRes = await sendWhatsAppReply(customerPhone, trimmedText, account.phoneNumberId, accessToken);
    const wamid = (platformRes as any)?.messages?.[0]?.id;

    const saved = await saveMessage(conversationId, "agent", trimmedText, { externalId: wamid });

    logger.info("whatsapp.conversations.human_sent", { conversationId, to: customerPhone, wamid });
    return res.status(201).json({ data: saved });
  }

  /**
   * POST /v1/whatsapp/conversations/:id/media
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
      throw new AppError("Access denied or conversation not found", 404);
    }

    const account = await prisma.whatsAppAccount.findFirst({
      where: { phoneNumberId: conversation.pageId, isActive: true },
    });

    if (!account) throw new AppError("WhatsApp account not found", 404);

    const accessToken = decryptFacebookSecret(account.accessToken);

    const mediaId = await uploadWhatsAppMedia(conversation.pageId, accessToken, file.buffer, file.originalname, file.mimetype);

    const type = file.mimetype.split("/")[0] === "application" ? "document" : file.mimetype.split("/")[0];
    const platformRes = await sendWhatsAppMedia(conversation.senderId, mediaId, type, conversation.pageId, accessToken, messageText, file.originalname);

    const wamid = (platformRes as any)?.messages?.[0]?.id;

    const sentMsg = await saveMessage(conversationId, "agent", messageText, {
      externalId: wamid,
      type,
      mediaId,
      mediaMetadata: { mimeType: file.mimetype, filename: file.originalname, size: file.size }
    });

    return res.json(sentMsg);
  }

  /**
   * GET /v1/whatsapp/conversations
   */
  async listConversations(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const { page, limit, status } = req.query as any;
    const result = await listWhatsAppConversations(userId, page, limit, status);
    return res.json(result);
  }

  /**
   * GET /v1/whatsapp/conversations/:id/messages
   */
  async listMessages(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;
    const { limit, cursor } = req.query as any;

    await getAuthorizedConversation(userId, conversationId);
    const result = await listConversationMessages(conversationId, limit, cursor);
    return res.json(result);
  }

  /**
   * POST /v1/whatsapp/conversations/:id/template
   */
  async sendTemplate(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;
    const { templateName, languageCode, components, textPreview } = req.body;

    const conversation = await getAuthorizedConversation(userId, conversationId);

    const account = await prisma.whatsAppAccount.findFirst({
      where: { phoneNumberId: conversation.pageId, userId, isActive: true },
      select: { accessToken: true, phoneNumberId: true },
    });

    if (!account) throw new AppError("WhatsApp account not found", 404);

    const accessToken = decryptFacebookSecret(account.accessToken);
    const customerPhone = conversation.customerPhone ?? conversation.senderId;

    await sendWhatsAppTemplate(customerPhone, templateName, languageCode, components || [], account.phoneNumberId, accessToken);

    const saved = await saveMessage(conversationId, "agent", textPreview || `[Template: ${templateName}]`);
    return res.status(201).json({ data: saved });
  }

  /**
   * GET /v1/whatsapp/templates
   */
  async listTemplates(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const account = await prisma.whatsAppAccount.findFirst({
      where: { userId, isActive: true },
      select: { wabaId: true, accessToken: true },
    });

    if (!account || !account.wabaId) return res.json({ data: [] });

    const accessToken = decryptFacebookSecret(account.accessToken);
    const templates = await listWhatsAppTemplates(account.wabaId, accessToken);
    return res.json({ data: templates });
  }

  /**
   * DELETE /v1/whatsapp/accounts/:id
   */
  async deactivateAccount(req: Request, res: Response) {
    const userId = (req as any).user.id;
    const { id } = req.params as any;

    const account = await prisma.whatsAppAccount.findFirst({
      where: { id, userId, isActive: true },
    });

    if (!account) throw new AppError("WhatsApp account not found", 404);

    if (account.wabaId && account.accessToken) {
      try {
        const token = decryptFacebookSecret(account.accessToken);
        await unsubscribeWebhook(account.wabaId, token);
      } catch (err: any) {
        logger.warn("whatsapp.account.meta_unsubscribe_failed", { id, error: err.message });
      }
    }

    await prisma.whatsAppAccount.update({ where: { id }, data: { isActive: false } });
    await invalidateWhatsAppAccountCache(account.phoneNumberId);
    return res.json({ success: true, message: "Account deactivated successfully" });
  }

  /**
   * POST /v1/whatsapp/accounts/:id/link-business
   */
  async linkBusiness(req: Request, res: Response) {
    const userId = (req as any).user.id;
    const { id } = req.params as any;
    const { businessProfileId } = req.body;

    if (!businessProfileId) throw new AppError("businessProfileId is required", 400);

    const account = await prisma.whatsAppAccount.findFirst({ where: { id, userId, isActive: true } });
    if (!account) throw new AppError("WhatsApp account not found", 404);

    const businessProfileIdNum = z.coerce.number().int().positive().parse(businessProfileId);
    const businessProfile = await prisma.businessProfile.findFirst({ where: { id: businessProfileIdNum, userId } });

    if (!businessProfile) throw new AppError("Business profile not found", 404);

    const updated = await prisma.whatsAppAccount.update({
      where: { id },
      data: { businessProfileId: businessProfileIdNum },
    });
    await invalidateWhatsAppAccountCache(account.phoneNumberId).catch(() => {});

    return res.json({ success: true, account: this.sanitiseAccount(updated) });
  }

  /**
   * DELETE /v1/whatsapp/accounts/:id/unlink-business
   */
  async unlinkBusiness(req: Request, res: Response) {
    const userId = (req as any).user.id;
    const { id } = req.params as any;

    const account = await prisma.whatsAppAccount.findFirst({ where: { id, userId, isActive: true } });
    if (!account) throw new AppError("WhatsApp account not found", 404);

    const updated = await prisma.whatsAppAccount.update({ where: { id }, data: { businessProfileId: null } });
    await invalidateWhatsAppAccountCache(account.phoneNumberId).catch(() => {});
    return res.json({ success: true, account: this.sanitiseAccount(updated) });
  }

  /**
   * ADMIN ONLY: List WhatsApp accounts for a specific user.
   * GET /v1/whatsapp/admin/users/:userId/accounts
   */
  async adminListUserAccounts(req: Request, res: Response) {
    const { userId } = req.params;
    const accounts = await prisma.whatsAppAccount.findMany({
      where: { userId: parseInt(userId) },
      include: {
        businessProfile: { select: { name: true } },
      },
    });

    return res.json({
      success: true,
      data: accounts.map(this.sanitiseAccount),
    });
  }

  /**
   * ADMIN ONLY: Transfer a WhatsApp account to a new user/profile.
   * POST /v1/whatsapp/admin/transfer
   */
  async adminTransfer(req: Request, res: Response) {
    const { accountId, targetUserId, targetBusinessProfileId } = req.body;

    if (!accountId || !targetUserId || !targetBusinessProfileId) {
      throw new AppError("accountId, targetUserId, and targetBusinessProfileId are required", 400);
    }

    const result = await adminTransferAccount({
      accountId: parseInt(accountId),
      targetUserId: parseInt(targetUserId),
      targetBusinessProfileId: parseInt(targetBusinessProfileId),
    });

    return res.json({
      success: true,
      message: "Account and conversations transferred successfully",
      data: result,
    });
  }

  private sanitiseAccount(account: any): any {
    const { accessToken: _omit, ...safe } = account;
    return safe;
  }
}

export const whatsappController = new WhatsAppController();









