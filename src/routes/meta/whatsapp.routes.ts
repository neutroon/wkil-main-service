import { Router, Request, Response } from "express";
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

const whatsappRoutes = Router();

// ─── Sub-routers ──────────────────────────────────────────────────────────────
whatsappRoutes.use("/conversations", conversationsRoutes);

const isDev = process.env.NODE_ENV !== "production";

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
              id?: string;   // wamid
              from?: string;
              type?: string;
              text?: { body?: string };
            }>;
          };
          field?: string;
        }>;
      }>;
    };

    logger.info("whatsapp.webhook.event_received");

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
              const inserted = await prisma.processedWhatsAppMessage.createMany({
                data: [{ wamid }],
                skipDuplicates: true,
              });
              if (inserted.count === 0) {
                logger.debug("whatsapp.webhook.duplicate_wamid_skipped", { wamid });
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
          });

          enqueueWhatsAppJob({ phoneNumberId, from, messageText, wamid });
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
 * Query: { code: string }
 */
whatsappRoutes.get(
  "/oauth/phone-numbers",
  authenticateToken,
  async (req: Request, res: Response) => {
    try {
      const { code } = req.query;
      if (!code) {
        return res.status(400).json({ error: "code is required" });
      }

      const accessToken = await exchangeCodeForToken(code as string);
      const accounts = await discoverWabaAccounts(accessToken);

      res.json({ data: accounts });
    } catch (error: any) {
      logger.error("whatsapp.oauth.phone_numbers_failed", { error: error.message });
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
      const { code, phoneNumberId, businessProfileId } = req.body;

      if (!code || !phoneNumberId) {
        return res.status(400).json({ error: "code and phoneNumberId are required" });
      }

      // Step 1: Exchange SDK code for token
      const accessToken = await exchangeCodeForToken(code as string);

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
        businessProfileId: businessProfileId ? parseInt(businessProfileId) : undefined,
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

      res.status(201).json({ success: true, account: sanitiseAccount(account) });
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
  const { accessToken: _omit, ...safe } = account as { accessToken?: string } & Record<string, unknown>;
  return safe;
}

export default whatsappRoutes;
