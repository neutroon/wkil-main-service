import { logger } from "@utils/logger";
import { AppError } from "@middlewares/errorHandler.middleware";

const WHATSAPP_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Send a text reply via WhatsApp Cloud API (v25.0).
 */
export async function sendWhatsAppReply(
  to: string,
  text: string,
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
        type: "text",
        text: { body: text },
      }),
      signal: AbortSignal.timeout(WHATSAPP_REQUEST_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    const error = (await response.json()) as any;
    throw new AppError(`WhatsApp Cloud API error: ${JSON.stringify(error)}`, 502);
  }

  return response.json();
}

/**
 * Send a media message via WhatsApp Cloud API (v25.0).
 */
export async function sendWhatsAppMedia(
  to: string,
  mediaId: string | null,
  type: string, // image, audio, video, document
  phoneNumberId: string,
  accessToken: string,
  caption?: string,
  fileName?: string,
  url?: string,
): Promise<any> {
  const mediaBody: any = mediaId ? { id: mediaId } : { link: url };
  if (caption && (type === "image" || type === "video" || type === "document")) {
    mediaBody.caption = caption;
  }
  if (fileName && type === "document") {
    mediaBody.filename = fileName;
  }

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
        type: type,
        [type]: mediaBody,
      }),
      signal: AbortSignal.timeout(WHATSAPP_REQUEST_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    const error = (await response.json()) as any;
    throw new AppError(`WhatsApp Cloud API media error: ${JSON.stringify(error)}`, 502);
  }

  return response.json();
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
      signal: AbortSignal.timeout(WHATSAPP_REQUEST_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(WHATSAPP_REQUEST_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    const error = await response.json();
    logger.error("whatsapp.templates.list_failed", { wabaId, error });
    throw new AppError(`WhatsApp Templates API error: ${JSON.stringify(error)}`, 502);
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
      signal: AbortSignal.timeout(WHATSAPP_REQUEST_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    const error = await response.json();
    throw new AppError(`WhatsApp Template Send error: ${JSON.stringify(error)}`, 502);
  }

  return response.json();
}
