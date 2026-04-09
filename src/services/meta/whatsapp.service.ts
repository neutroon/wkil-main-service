import prisma from "../../config/prisma";
import { logger } from "../../utils/logger";
import { decryptFacebookSecret } from "../../utils/tokenCrypto";
import {
  getOrCreateConversation,
  getConversationHistory,
  saveMessage,
} from "./conversation.service";
import { computeBusinessChatReply } from "../chat/businessChatReply.service";
import { historyToLlmTurns, toPromptMessages } from "../chat/conversationTurns";
import { emitToBusiness, emitToConversation } from "../../utils/socket";

const FALLBACK_REPLY =
  "Sorry, we can't respond right now. Please try again or contact the business directly.";

/**
 * Send a text reply via WhatsApp Cloud API (v25.0).
 */
export async function sendWhatsAppReply(
  to: string,
  text: string,
  phoneNumberId: string,
  accessToken: string,
): Promise<void> {
  const response = await fetch(
    `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    },
  );

  if (!response.ok) {
    const error = (await response.json()) as unknown;
    throw new Error(`WhatsApp Cloud API error: ${JSON.stringify(error)}`);
  }
}

export async function sendWhatsAppAction(
  messageId: string,
  phoneNumberId: string,
  accessToken: string,
): Promise<void> {
  const response = await fetch(
    `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      }),
    },
  );
  if (!response.ok) {
    logger.warn("whatsapp.sender_action_failed", {
      messageId,
      error: await response.text(),
    });
  }
}

/**
 * List approved WhatsApp message templates for a given WABA.
 */
export async function listWhatsAppTemplates(
  wabaId: string,
  accessToken: string,
): Promise<any[]> {
  const response = await fetch(
    `https://graph.facebook.com/v25.0/${wabaId}/message_templates?status=APPROVED`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    const error = await response.json();
    logger.error("whatsapp.templates.list_failed", { wabaId, error });
    throw new Error(`WhatsApp Templates API error: ${JSON.stringify(error)}`);
  }

  const result = (await response.json()) as { data: any[] };
  return result.data || [];
}

/**
 * Send a pre-approved Template message.
 */
export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  components: any[],
  phoneNumberId: string,
  accessToken: string,
): Promise<any> {
  const response = await fetch(
    `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: languageCode },
          components,
        },
      }),
    },
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`WhatsApp Template Send error: ${JSON.stringify(error)}`);
  }

  return response.json();
}

/**
 * Core handler: look up the WhatsApp account → business profile → run RAG + AI → reply.
 * Uses the shared Conversation tables (pageId = phoneNumberId, senderId = customer phone).
 */
export async function handleWhatsAppMessage(
  phoneNumberId: string,
  from: string,
  messageText: string,
  wamid?: string,
): Promise<void> {
  // ... existing code ...
  const account = await prisma.whatsAppAccount.findFirst({
    where: { phoneNumberId, isActive: true },
    include: {
      businessProfile: {
        include: {
          externalDataSources: { where: { isActive: true } },
          crmIntegrations: { where: { isActive: true }, take: 1 },
        },
      },
    },
  });

  if (!account) {
    logger.error("whatsapp.account_not_found", { phoneNumberId });
    return;
  }
  if (!account.businessProfileId || !account.businessProfile) {
    logger.error("whatsapp.no_business_profile", { phoneNumberId });
    return;
  }

  let accessToken: string;
  try {
    accessToken = decryptFacebookSecret(account.accessToken);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("whatsapp.decrypt_token_failed", {
      phoneNumberId,
      error: msg,
    });
    return;
  }

  if (wamid) {
    void sendWhatsAppAction(wamid, phoneNumberId, accessToken);
  }

  const businessProfile = account.businessProfile;

  try {
    const conversation = await getOrCreateConversation(
      phoneNumberId,
      from,
      account.businessProfileId,
      { channel: "whatsapp", customerPhone: from },
    );
    const historyRows = await getConversationHistory(conversation.id);
    const userSaved = await saveMessage(conversation.id, "user", messageText);
    emitToBusiness(account.businessProfileId, "new_message", {
      conversationId: conversation.id,
      message: userSaved,
    });
    emitToConversation(conversation.id, "new_message", {
      message: userSaved,
    });

    const historyForPrompt = toPromptMessages(historyRows);
    historyForPrompt.push({ role: "user", content: messageText });
    const historyTurns = historyToLlmTurns(historyForPrompt);

    const reply = await computeBusinessChatReply({
      businessProfile,
      messageText,
      historyTurns,
      channel: "whatsapp",
      customerPhone: from,
    });

    const modelSaved = await saveMessage(conversation.id, "model", reply);
    emitToBusiness(account.businessProfileId, "new_message", {
      conversationId: conversation.id,
      message: modelSaved,
    });
    emitToConversation(conversation.id, "new_message", {
      message: modelSaved,
    });
    await sendWhatsAppReply(from, reply, phoneNumberId, accessToken);

    logger.info("whatsapp.reply_sent", {
      phoneNumberId,
      from,
      preview: reply.slice(0, 80),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("whatsapp.handle_failed", {
      phoneNumberId,
      from,
      error: message,
    });
    try {
      await sendWhatsAppReply(
        from,
        FALLBACK_REPLY,
        phoneNumberId,
        accessToken!,
      );
    } catch (sendErr: unknown) {
      const sm = sendErr instanceof Error ? sendErr.message : String(sendErr);
      logger.error("whatsapp.fallback_send_failed", {
        phoneNumberId,
        from,
        error: sm,
      });
    }
  }
}
