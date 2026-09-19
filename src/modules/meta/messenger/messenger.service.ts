import { logger } from "@utils/logger";
import { AppError, ProviderDeliveryRejectedError } from "@middlewares/errorHandler.middleware";

export async function sendMessengerReply(
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
    throw new ProviderDeliveryRejectedError(`Messenger Send API error: ${JSON.stringify(error)}`);
  }

  return response.json();
}

/**
 * Send a media message via Messenger API (v25.0) using an attachment_id.
 */
export async function sendMessengerMedia(
  recipientId: string,
  attachmentId: string | null,
  type: "image" | "video" | "audio" | "file",
  pageAccessToken: string,
  url?: string,
) {
  const payload = attachmentId
    ? { attachment_id: attachmentId }
    : { url: url, is_reusable: true };

  const response = await fetch(
    `https://graph.facebook.com/v25.0/me/messages?access_token=${pageAccessToken}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: {
          attachment: {
            type: type,
            payload: payload,
          },
        },
      }),
    },
  );

  if (!response.ok) {
    const error = await response.json();
    throw new AppError(`Messenger Media Send API error: ${JSON.stringify(error)}`, 502);
  }

  return response.json();
}

export async function sendMessengerAction(
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
