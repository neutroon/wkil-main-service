import { Router, Request, Response } from "express";
import { createHmac } from "crypto";
import { handleMessengerMessage } from "../../services/meta/messenger.service";

const messengerRoutes = Router();

// ─── Webhook Verification (Meta calls this once when you set up the webhook) ──

messengerRoutes.get("/webhook", (req: Request, res: Response) => {
  console.log("[Messenger] Verification request received");
  console.log("Query params:", req.query);
  console.log("Expected token:", process.env.MESSENGER_VERIFY_TOKEN);

  const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log(`mode: ${mode}, token: ${token}, challenge: ${challenge}`);

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[Messenger] Webhook verified ✅");
    return res.status(200).send(challenge);
  }

  console.log("[Messenger] Verification failed ❌");
  return res.status(403).json({ error: "Verification failed" });
});

// ─── Incoming Messages ────────────────────────────────────────────────────────

messengerRoutes.post("/webhook", async (req: Request, res: Response) => {
  // Always respond 200 immediately — Meta will retry if you don't
  res.status(200).send("EVENT_RECEIVED");

  try {
    // Verify the request is from Meta
    const signature = req.headers["x-hub-signature-256"] as string;
    if (!verifySignature(req.body, signature)) {
      console.error("[Messenger] Invalid signature");
      return;
    }

    const body = req.body;

    if (body.object !== "page") return;

    for (const entry of body.entry) {
      const pageId = entry.id;

      for (const event of entry.messaging) {
        // Ignore delivery/read receipts and echoes
        if (!event.message || event.message.is_echo) continue;

        const senderId = event.sender.id;
        const messageText = event.message.text;

        if (!messageText) continue; // ignore attachments for now

        console.log(
          `[Messenger] Message from ${senderId} on page ${pageId}: "${messageText}"`,
        );

        // History comes from client for stateful conversations
        // For Messenger, history is managed on the frontend/session layer
        await handleMessengerMessage(pageId, senderId, messageText);
      }
    }
  } catch (error) {
    console.error("[Messenger] Webhook error:", error);
  }
});

// ─── Signature Verification ───────────────────────────────────────────────────

function verifySignature(rawBody: any, signature: string): boolean {
  if (!signature) return false;

  const APP_SECRET = process.env.FB_APP_SECRET;
  if (!APP_SECRET) return false;

  const body = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(JSON.stringify(rawBody));

  const expected =
    "sha256=" + createHmac("sha256", APP_SECRET).update(body).digest("hex");

  return expected === signature;
}

export default messengerRoutes;
