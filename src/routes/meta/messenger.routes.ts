import { Router, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../../config/prisma";
import { enqueueMessengerJob } from "../../queues/messenger.queue";
import { logger } from "../../utils/logger";
import { verifyMetaWebhookSignature } from "../../utils/metaWebhook";

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
        process.env.FB_APP_SECRET,
      )
    ) {
      logger.error("messenger.webhook.invalid_signature");
      return;
    }

    let body: unknown;
    try {
      const str = Buffer.isBuffer(rawBody)
        ? rawBody.toString("utf8")
        : JSON.stringify(rawBody);
      body = JSON.parse(str) as unknown;
    } catch {
      logger.error("messenger.webhook.invalid_json");
      return;
    }

    const payload = body as {
      object?: string;
      entry?: Array<{
        id?: string;
        messaging?: Array<{
          sender?: { id?: string };
          message?: { text?: string; is_echo?: boolean; mid?: string };
        }>;
      }>;
    };

    logger.info("messenger.webhook.event_received");

    if (payload.object !== "page" || !Array.isArray(payload.entry)) return;

    for (const entry of payload.entry) {
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
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("messenger.webhook.handler_error", { error: message });
  }
});

export default messengerRoutes;
