import { WhatsAppTemplateRejectedError } from "./whatsapp.delivery-errors";
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
  options: { name?: string } = {},
): Promise<any[]> {
  const baseUrl = new URL(
    `https://graph.facebook.com/v25.0/${encodeURIComponent(wabaId)}/message_templates`,
  );
  baseUrl.searchParams.set("status", "APPROVED");
  if (options.name) baseUrl.searchParams.set("name", options.name);
  let pageUrl = new URL(baseUrl);
  const templates: any[] = [];
  const seenCursors = new Set<string>();
  const invalidPage = () => new AppError(
    "WhatsApp template listing returned invalid pagination", 502, true,
    "WHATSAPP_TEMPLATE_LIST_INVALID",
  );

  while (true) {
    const response = await fetch(pageUrl.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(WHATSAPP_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.error("whatsapp.templates.list_failed", { status: response.status });
      throw new AppError("WhatsApp template listing failed", 502, true,
        "WHATSAPP_TEMPLATE_LIST_FAILED");
    }
    const result = await response.json() as {
      data?: any[]; paging?: { next?: unknown };
    } | null;
    if (!result || !Array.isArray(result.data)) throw invalidPage();
    templates.push(...result.data);
    const next = result.paging?.next;
    if (next === undefined || next === null) return templates;
    if (typeof next !== "string" || !next) throw invalidPage();
    let nextUrl: URL;
    try { nextUrl = new URL(next); } catch { throw invalidPage(); }
    if (nextUrl.origin !== baseUrl.origin || nextUrl.pathname !== baseUrl.pathname ||
        nextUrl.username || nextUrl.password) throw invalidPage();
    const cursor = nextUrl.searchParams.get("after");
    if (!cursor || seenCursors.has(cursor)) throw invalidPage();
    seenCursors.add(cursor);
    // Rebuild from the authorized account and filters; never copy a token or
    // changed account/filter from the provider's pagination URL.
    pageUrl = new URL(baseUrl);
    pageUrl.searchParams.set("after", cursor);
  }
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
    throw new WhatsAppTemplateRejectedError(response.status, error);
  }

  return response.json();
}
