import prisma from "../../config/prisma";
import { logger } from "../../utils/logger";
import { decryptFacebookSecret } from "../../utils/tokenCrypto";
import {
  getOrCreateConversation,
  getConversationHistory,
  saveMessage,
} from "./conversation.service";
import { computeBusinessChatReply } from "../chat/businessChatReply.service";
import {
  historyToLlmTurns,
  toPromptMessages,
} from "../chat/conversationTurns";

const FALLBACK_REPLY =
  "Sorry, we can't respond right now. Please try again or contact the business directly.";

async function sendMessengerReply(
  recipientId: string,
  text: string,
  pageAccessToken: string,
) {
  const response = await fetch(
    `https://graph.facebook.com/v25.0/me/messages?access_token=${pageAccessToken}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
      }),
    },
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Messenger Send API error: ${JSON.stringify(error)}`);
  }

  return response.json();
}

async function sendMessengerAction(
  recipientId: string,
  action: "mark_seen" | "typing_on" | "typing_off",
  pageAccessToken: string,
) {
  await fetch(
    `https://graph.facebook.com/v25.0/me/messages?access_token=${pageAccessToken}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        sender_action: action,
      }),
    },
  ).catch((err) => {
    logger.warn("messenger.sender_action_failed", {
      recipientId,
      action,
      error: String(err),
    });
  });
}

export async function handleMessengerMessage(
  pageId: string,
  senderId: string,
  messageText: string,
) {
  const page = await prisma.facebookPage.findFirst({
    where: { pageId, isActive: true },
    include: {
      businessProfile: {
        include: {
          externalDataSources: { where: { isActive: true } },
          crmIntegrations: { where: { isActive: true }, take: 1 },
        },
      },
    },
  });

  if (!page) {
    logger.error("messenger.page_not_found", { pageId });
    return;
  }
  if (!page.businessProfileId || !page.businessProfile) {
    logger.error("messenger.no_business_profile", { pageId });
    return;
  }

  let pageAccessToken: string;
  try {
    pageAccessToken = decryptFacebookSecret(page.pageAccessToken);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("messenger.decrypt_token_failed", { pageId, error: msg });
    return;
  }

  void sendMessengerAction(senderId, "mark_seen", pageAccessToken);
  void sendMessengerAction(senderId, "typing_on", pageAccessToken);

  const businessProfile = page.businessProfile;

  try {
    const conversation = await getOrCreateConversation(
      pageId,
      senderId,
      page.businessProfileId,
      { channel: "messenger" },
    );
    const historyRows = await getConversationHistory(conversation.id);
    await saveMessage(conversation.id, "user", messageText);

    const historyForPrompt = toPromptMessages(historyRows);
    historyForPrompt.push({ role: "user", content: messageText });
    const historyTurns = historyToLlmTurns(historyForPrompt);

    const reply = await computeBusinessChatReply({
      businessProfile,
      messageText,
      historyTurns,
      channel: "messenger",
    });

    await saveMessage(conversation.id, "model", reply);
    await sendMessengerReply(senderId, reply, pageAccessToken);

    logger.info("messenger.reply_sent", {
      pageId,
      senderId,
      preview: reply.slice(0, 80),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("messenger.handle_failed", {
      pageId,
      senderId,
      error: message,
    });
    try {
      await sendMessengerReply(senderId, FALLBACK_REPLY, pageAccessToken);
    } catch (sendErr: unknown) {
      const sm = sendErr instanceof Error ? sendErr.message : String(sendErr);
      logger.error("messenger.fallback_send_failed", {
        pageId,
        senderId,
        error: sm,
      });
    }
  }
}
