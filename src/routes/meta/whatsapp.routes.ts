import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma";
import { enqueueWhatsAppJob } from "../../queues/whatsapp.queue";
import { logger } from "../../utils/logger";
import { verifyMetaWebhookSignature } from "../../utils/metaWebhook";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { encryptFacebookSecret } from "../../utils/tokenCrypto";
import conversationsRoutes from "./conversations.routes";
import {
  exchangeCodeForToken,
  discoverWabaAccounts,
  subscribeWebhook,
  saveWhatsAppAccount,
} from "../../services/meta/whatsappOauth.service";
import { emitToBusiness } from "../../utils/socket";

const whatsappRoutes = Router();

// ─── Sub-routers ──────────────────────────────────────────────────────────────
whatsappRoutes.use("/conversations", conversationsRoutes);

const isDev = process.env.NODE_ENV !== "production";
const OAUTH_EXCHANGE_REF_TTL_MS = 10 * 60 * 1000;
const OAUTH_EXCHANGE_REF_MAX_ENTRIES = 500;
const oauthPreviewTokenCache = new Map<
  string,
  { userId: number; accessToken: string; createdAt: number }
>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isProcessedWhatsAppTableMissing(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2021") return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("ProcessedWhatsAppMessage") && msg.includes("does not exist")
  );
}

function pruneOauthPreviewTokenCache(now: number): void {
  for (const [key, value] of oauthPreviewTokenCache.entries()) {
    if (now - value.createdAt > OAUTH_EXCHANGE_REF_TTL_MS) {
      oauthPreviewTokenCache.delete(key);
    }
  }

  // Keep cache bounded in long-running processes.
  if (oauthPreviewTokenCache.size <= OAUTH_EXCHANGE_REF_MAX_ENTRIES) return;
  const overflow = oauthPreviewTokenCache.size - OAUTH_EXCHANGE_REF_MAX_ENTRIES;
  const oldestEntries = [...oauthPreviewTokenCache.entries()]
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .slice(0, overflow);
  for (const [key] of oldestEntries) {
    oauthPreviewTokenCache.delete(key);
  }
}

// ─── Webhook verification (GET) ───────────────────────────────────────────────
// Meta calls this once when you save the webhook URL in the Developer Console.

whatsappRoutes.get("/webhook", (req: Request, res: Response) => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
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
});

// ─── Incoming messages (POST) ─────────────────────────────────────────────────
// Meta sends all messages here. We respond 200 immediately then process async.

whatsappRoutes.post("/webhook", async (req: Request, res: Response) => {
  // Always ACK first — Meta retries if we don't respond within ~20 s.
  res.status(200).send("EVENT_RECEIVED");

  try {
    const rawBody = req.body as Buffer | unknown;
    const signature = req.headers["x-hub-signature-256"] as string | undefined;

    if (
      !verifyMetaWebhookSignature(
        rawBody as Buffer,
        signature,
        process.env.FB_APP_SECRET,
      )
    ) {
      logger.error("whatsapp.webhook.invalid_signature");
      return;
    }

    let body: unknown;
    try {
      const str = Buffer.isBuffer(rawBody)
        ? rawBody.toString("utf8")
        : JSON.stringify(rawBody);
      body = JSON.parse(str) as unknown;
    } catch {
      logger.error("whatsapp.webhook.invalid_json");
      return;
    }

    // WhatsApp Cloud API webhook shape
    const payload = body as {
      object?: string;
      entry?: Array<{
        id?: string;
        changes?: Array<{
          value?: {
            messaging_product?: string;
            metadata?: { phone_number_id?: string };
            messages?: Array<{
              id?: string; // wamid
              from?: string;
              type?: string;
              text?: { body?: string };
            }>;
            contacts?: Array<{
              profile?: { name?: string };
              wa_id?: string;
            }>;
          };
          field?: string;
        }>;
      }>;
    };

    logger.info("whatsapp.webhook.event_received", {
      object: payload.object,
      entries: payload.entry?.length,
      // Log presence of contacts for debugging
      hasContacts: Boolean(payload.entry?.[0]?.changes?.[0]?.value?.contacts),
    });

    if (isDev) {
      logger.debug("whatsapp.webhook.raw_payload", {
        body: JSON.stringify(payload, null, 2),
      });
    }

    if (
      payload.object !== "whatsapp_business_account" ||
      !Array.isArray(payload.entry)
    ) {
      return;
    }

    for (const entry of payload.entry) {
      if (!Array.isArray(entry.changes)) continue;

      for (const change of entry.changes) {
        if (change.field !== "messages") continue;

        const value = change.value;
        const phoneNumberId = value?.metadata?.phone_number_id;
        const messages = value?.messages;
        const contacts = value?.contacts;
        const statuses = (value as any)?.statuses;

        // 1. Handle Status Updates (Read Receipts / Delivery Ticks)
        if (Array.isArray(statuses)) {
          for (const status of statuses) {
            const { id: wamid, status: newStatus } = status;

            try {
              const msg = await prisma.conversationMessage.findUnique({
                where: { externalId: wamid },
                select: {
                  id: true,
                  conversation: {
                    select: { businessProfileId: true, id: true },
                  },
                },
              });

              if (msg) {
                const updatedMsg = await prisma.conversationMessage.update({
                  where: { id: msg.id },
                  data: { status: newStatus.toUpperCase() },
                });

                emitToBusiness(
                  msg.conversation.businessProfileId,
                  "message_status_updated",
                  {
                    conversationId: msg.conversation.id,
                    messageId: msg.id,
                    status: updatedMsg.status,
                  },
                );
              }
            } catch (e) {
              logger.warn("whatsapp.webhook.status_update_failed", {
                wamid,
                error: String(e),
              });
            }
          }
        }

        // 2. Handle Inbound Messages
        // Extract profile name if available
        const customerName =
          (Array.isArray(contacts) && contacts[0]?.profile?.name) || undefined;

        if (!phoneNumberId || !Array.isArray(messages)) continue;

        for (const msg of messages) {
          // Only handle inbound text messages
          if (msg.type !== "text") continue;

          const wamid = msg.id;
          const from = msg.from;
          const messageText = msg.text?.body;

          if (!wamid || !from || !messageText) continue;

          // Idempotency — deduplicate Meta retries by wamid
          if (wamid) {
            try {
              const inserted = await prisma.processedWhatsAppMessage.createMany(
                {
                  data: [{ wamid }],
                  skipDuplicates: true,
                },
              );
              if (inserted.count === 0) {
                logger.debug("whatsapp.webhook.duplicate_wamid_skipped", {
                  wamid,
                });
                continue;
              }
            } catch (e: unknown) {
              if (isProcessedWhatsAppTableMissing(e)) {
                logger.warn(
                  "whatsapp.webhook.idempotency_table_missing_run_prisma_migrate",
                );
              } else {
                throw e;
              }
            }
          }

          logger.info("whatsapp.webhook.message_enqueued", {
            phoneNumberId,
            from,
            customerName,
          });

          enqueueWhatsAppJob({
            phoneNumberId,
            from,
            messageText,
            wamid,
            customerName,
          });
        }
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("whatsapp.webhook.handler_error", { error: message });
  }
});

// ─── Embedded Signup OAuth (authenticated) ───────────────────────────────────

/**
 * GET /v1/whatsapp/oauth/phone-numbers
 * Preview step: Given an SDK code, return available WABA accounts & phone numbers
 * so the frontend can display a picker before committing.
 * Query: { code: string, redirectUri: string }
 * redirectUri must match Meta's JS SDK "current page" URL (origin + path + query),
 * identical to POST /oauth — same value used when exchanging the code at Graph API.
 */
whatsappRoutes.get(
  "/oauth/phone-numbers",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id as number;
      const { code } = req.query;
      // redirectUri is optional: omitted for FB.login SDK codes, present for manual dialog flow.
      const redirectUri =
        typeof req.query.redirectUri === "string"
          ? req.query.redirectUri
          : undefined;
      const now = Date.now();
      pruneOauthPreviewTokenCache(now);
      if (!code) {
        return res.status(400).json({ error: "code is required" });
      }

      const accessToken = await exchangeCodeForToken(
        code as string,
        redirectUri,
      );
      const accounts = await discoverWabaAccounts(accessToken);
      const exchangeRef = randomUUID();
      oauthPreviewTokenCache.set(exchangeRef, {
        userId,
        accessToken,
        createdAt: now,
      });

      res.json({ data: accounts, exchangeRef });
    } catch (error: any) {
      logger.error("whatsapp.oauth.phone_numbers_failed", {
        error: error.message,
      });
      res.status(500).json({ error: error.message });
    }
  },
);

/**
 * POST /v1/whatsapp/oauth
 * Full Embedded Signup connect flow:
 *   1. Exchange SDK code for long-lived token
 *   2. Discover WABA + phone numbers
 *   3. Subscribe webhook on chosen WABA
 *   4. Upsert WhatsAppAccount row in DB
 * Body: { code: string, phoneNumberId: string, businessProfileId?: number }
 */
whatsappRoutes.post(
  "/oauth",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id;
      const {
        code,
        phoneNumberId,
        businessProfileId,
        redirectUri,
        exchangeRef,
      } = req.body;
      const now = Date.now();
      pruneOauthPreviewTokenCache(now);

      if (!phoneNumberId || (!code && !exchangeRef)) {
        return res.status(400).json({
          error:
            "phoneNumberId is required and either code or exchangeRef must be provided",
        });
      }

      // Step 1: Reuse the preview token when available; fallback to code exchange.
      let accessToken: string | undefined;
      if (exchangeRef && typeof exchangeRef === "string") {
        const cached = oauthPreviewTokenCache.get(exchangeRef);
        if (cached) {
          const expired = now - cached.createdAt > OAUTH_EXCHANGE_REF_TTL_MS;
          if (!expired && cached.userId === userId) {
            accessToken = cached.accessToken;
            oauthPreviewTokenCache.delete(exchangeRef);
            logger.info("whatsapp.oauth.exchange_ref_reused", { userId });
          } else if (expired) {
            oauthPreviewTokenCache.delete(exchangeRef);
            logger.warn("whatsapp.oauth.exchange_ref_expired", { userId });
          } else {
            logger.warn("whatsapp.oauth.exchange_ref_user_mismatch", {
              userId,
            });
          }
        } else {
          logger.warn("whatsapp.oauth.exchange_ref_not_found", { userId });
        }
      } else if (exchangeRef !== undefined) {
        logger.warn("whatsapp.oauth.exchange_ref_invalid", { userId });
      }
      if (!accessToken) {
        logger.info("whatsapp.oauth.exchange_ref_fallback_code_exchange", {
          userId,
        });
        accessToken = await exchangeCodeForToken(
          code as string,
          redirectUri as string,
        );
      }

      // Step 2: Discover phone numbers to find the matching WABA and display name
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
        return res.status(404).json({
          error: `Phone number ${phoneNumberId} not found in any WABA associated with this token.`,
        });
      }

      // Step 3: Subscribe our webhook to this WABA
      await subscribeWebhook(wabaId, accessToken);

      // Step 4: Persist into DB
      const account = await saveWhatsAppAccount({
        userId,
        wabaId,
        phoneNumberId,
        displayPhoneNumber,
        accessToken,
        businessProfileId: businessProfileId
          ? parseInt(businessProfileId)
          : undefined,
      });

      res.status(201).json({ success: true, account });
    } catch (error: any) {
      logger.error("whatsapp.oauth.connect_failed", { error: error.message });
      res.status(500).json({ error: error.message });
    }
  },
);

// ─── Account management (authenticated) ──────────────────────────────────────

/**
 * POST /v1/whatsapp/accounts
 * Register a WhatsApp Business phone number for the authenticated user.
 * Body: { phoneNumberId, displayPhoneNumber, wabaId, accessToken }
 */
whatsappRoutes.post(
  "/accounts",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id;
      const { phoneNumberId, displayPhoneNumber, wabaId, accessToken } =
        req.body;

      if (!phoneNumberId || !displayPhoneNumber || !wabaId || !accessToken) {
        return res.status(400).json({
          error:
            "phoneNumberId, displayPhoneNumber, wabaId, and accessToken are required",
        });
      }

      const encryptedToken = encryptFacebookSecret(accessToken as string);

      const account = await prisma.whatsAppAccount.upsert({
        where: { userId_phoneNumberId: { userId, phoneNumberId } },
        create: {
          userId,
          phoneNumberId,
          displayPhoneNumber,
          wabaId,
          accessToken: encryptedToken,
        },
        update: {
          displayPhoneNumber,
          wabaId,
          accessToken: encryptedToken,
          isActive: true,
        },
      });

      res
        .status(201)
        .json({ success: true, account: sanitiseAccount(account) });
    } catch (error: any) {
      logger.error("whatsapp.accounts.create_failed", { error: error.message });
      res.status(500).json({ error: error.message });
    }
  },
);

/**
 * GET /v1/whatsapp/accounts
 * List all active WhatsApp accounts for the authenticated user.
 */
whatsappRoutes.get(
  "/accounts",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id;
      const accounts = await prisma.whatsAppAccount.findMany({
        where: { userId, isActive: true },
        select: {
          id: true,
          phoneNumberId: true,
          displayPhoneNumber: true,
          wabaId: true,
          businessProfileId: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      res.json({ data: accounts });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },
);

/**
 * DELETE /v1/whatsapp/accounts/:id
 * Soft-deactivate a WhatsApp account.
 */
whatsappRoutes.delete(
  "/accounts/:id",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id;
      const id = parseInt(req.params.id);

      const account = await prisma.whatsAppAccount.findFirst({
        where: { id, userId, isActive: true },
      });

      if (!account) {
        return res.status(404).json({ error: "WhatsApp account not found" });
      }

      await prisma.whatsAppAccount.update({
        where: { id },
        data: { isActive: false },
      });

      res.json({ success: true, message: "Account deactivated successfully" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },
);

/**
 * POST /v1/whatsapp/accounts/:id/link-business
 * Link a WhatsApp account to a BusinessProfile.
 * Body: { businessProfileId }
 */
whatsappRoutes.post(
  "/accounts/:id/link-business",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id;
      const id = parseInt(req.params.id);
      const { businessProfileId } = req.body;

      if (!businessProfileId) {
        return res.status(400).json({ error: "businessProfileId is required" });
      }

      const account = await prisma.whatsAppAccount.findFirst({
        where: { id, userId, isActive: true },
      });

      if (!account) {
        return res.status(404).json({ error: "WhatsApp account not found" });
      }

      const businessProfile = await prisma.businessProfile.findFirst({
        where: { id: parseInt(businessProfileId), userId },
      });

      if (!businessProfile) {
        return res.status(404).json({ error: "Business profile not found" });
      }

      const updated = await prisma.whatsAppAccount.update({
        where: { id },
        data: { businessProfileId: parseInt(businessProfileId) },
      });

      res.json({ success: true, account: sanitiseAccount(updated) });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },
);

/**
 * DELETE /v1/whatsapp/accounts/:id/unlink-business
 * Unlink a WhatsApp account from its BusinessProfile.
 */
whatsappRoutes.delete(
  "/accounts/:id/unlink-business",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id;
      const id = parseInt(req.params.id);

      const account = await prisma.whatsAppAccount.findFirst({
        where: { id, userId, isActive: true },
      });

      if (!account) {
        return res.status(404).json({ error: "WhatsApp account not found" });
      }

      if (!account.businessProfileId) {
        return res
          .status(400)
          .json({ error: "Account is not linked to any business profile" });
      }

      const updated = await prisma.whatsAppAccount.update({
        where: { id },
        data: { businessProfileId: null },
      });

      res.json({ success: true, account: sanitiseAccount(updated) });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  },
);

// ─── Private helpers ──────────────────────────────────────────────────────────

/** Strip encrypted accessToken before sending to clients. */
function sanitiseAccount(
  account: Record<string, unknown>,
): Record<string, unknown> {
  const { accessToken: _omit, ...safe } = account as {
    accessToken?: string;
  } & Record<string, unknown>;
  return safe;
}

export default whatsappRoutes;
