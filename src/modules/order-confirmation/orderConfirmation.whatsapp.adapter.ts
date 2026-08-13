import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { getSystemSetting } from "@modules/settings/settings.service";
import {
  getOrCreateConversation,
  saveMessage,
} from "@modules/meta/core/conversation.service";
import {
  sendWhatsAppReply,
  sendWhatsAppTemplate,
} from "@modules/meta/whatsapp/whatsapp.service";
import { acquireBusinessSendPermit } from "./orderConfirmation.rateLimit";
import {
  findActiveWhatsAppSuppression,
  findNotificationForSending,
  markNotificationAttempted,
  prepareOrderActionTokensForSend,
  saveNotificationRenderedVariables,
  type OrderNotificationForSending,
} from "./orderConfirmation.repository";
import {
  renderOrderTemplateVariables,
  resolveActiveTemplateConfig,
  validateOrderTemplateMapping,
  type OrderTemplateConfig,
} from "./orderConfirmation.template.service";
import { hashOrderActionToken } from "./orderConfirmation.crypto";

export class OrderConfirmationRateLimitError extends Error {
  readonly code = "ORDER_CONFIRMATION_RATE_LIMIT";
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("WhatsApp order-confirmation send rate limit reached");
    this.name = "OrderConfirmationRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class OrderConfirmationGlobalKillSwitchError extends Error {
  readonly code = "GLOBAL_KILL_SWITCH";

  constructor() {
    super("GLOBAL_KILL_SWITCH");
    this.name = "OrderConfirmationGlobalKillSwitchError";
  }
}

export class OrderConfirmationSuppressedError extends Error {
  readonly code = "WHATSAPP_SUPPRESSED";

  constructor(reason: string) {
    super(reason || "WhatsApp recipient is suppressed");
    this.name = "OrderConfirmationSuppressedError";
  }
}

function isGlobalSwitchEnabled(value: string): boolean {
  return !["false", "0", "off", "disabled", "no"].includes(value.trim().toLowerCase());
}

async function ensureGlobalAndSuppressionAllowed(
  notification: OrderNotificationForSending,
): Promise<void> {
  const enabled = await getSystemSetting("order_confirmations_global_enabled", "true");
  if (!isGlobalSwitchEnabled(enabled)) {
    throw new OrderConfirmationGlobalKillSwitchError();
  }

  const suppression = await findActiveWhatsAppSuppression(
    notification.businessProfileId,
    notification.order.customerPhone,
  );
  if (suppression) {
    throw new OrderConfirmationSuppressedError(suppression.reason);
  }

}

function getAccount(notification: OrderNotificationForSending) {
  const account = notification.order.integration.whatsappAccount;
  if (!account) {
    throw new Error("WhatsApp account is not configured for this order integration");
  }
  return account;
}

async function getTemplateConfig(
  notification: OrderNotificationForSending,
  accountId: number,
): Promise<OrderTemplateConfig> {
  const locales = [notification.locale, notification.order.integration.defaultLocale]
    .filter((locale, index, all) => locale.length > 0 && all.indexOf(locale) === index);
  let lastError: unknown;
  for (const locale of locales) {
    try {
      return await resolveActiveTemplateConfig({
        integrationId: notification.order.integration.id,
        businessProfileId: notification.businessProfileId,
        whatsappAccountId: accountId,
        locale,
        eventType: "order.created",
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("No active WhatsApp order template is configured");
}

function providerMessageId(response: unknown): string {
  const id = (response as { messages?: Array<{ id?: unknown }> } | null)?.messages?.[0]?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("WhatsApp provider response did not include a message ID");
  }
  return id;
}

function orderPreview(
  notification: OrderNotificationForSending,
  body: string[],
): string {
  const orderNumber = notification.order.orderNumber;
  const details = body.filter(Boolean).join(" | ");
  return details ? `Order ${orderNumber}: ${details}` : `Order ${orderNumber}`;
}

export async function sendConfirmationNotification(notificationId: number): Promise<{
  providerMessageId: string;
  previewText: string;
}> {
  const notification = await findNotificationForSending(notificationId);
  if (!notification) throw new Error("Order notification not found");

  await ensureGlobalAndSuppressionAllowed(notification);

  const account = getAccount(notification);
  const templateConfig = await getTemplateConfig(notification, account.id);
  validateOrderTemplateMapping(templateConfig.variableMapping, true);
  const actionTokens = await prepareOrderActionTokensForSend(notificationId);
  if (
    hashOrderActionToken(actionTokens.confirmToken) !== actionTokens.confirmTokenHash ||
    hashOrderActionToken(actionTokens.cancelToken) !== actionTokens.cancelTokenHash
  ) {
    throw new Error("Prepared order action token verification failed");
  }
  const accessToken = decryptFacebookSecret(account.accessToken);
  const rendered = renderOrderTemplateVariables(
    notification.order as any,
    templateConfig.variableMapping,
    {
      confirm: actionTokens.confirmToken,
      cancel: actionTokens.cancelToken,
    },
    templateConfig.locale,
  );
  if (!rendered.buttons?.confirm || !rendered.buttons.cancel) {
    throw new Error("Confirm and Cancel payloads are required");
  }
  const components = [
    {
      type: "body",
      parameters: rendered.body.map((text) => ({ type: "text", text })),
    },
    {
      type: "button",
      sub_type: "quick_reply",
      index: "0",
      parameters: [{ type: "payload", payload: rendered.buttons.confirm }],
    },
    {
      type: "button",
      sub_type: "quick_reply",
      index: "1",
      parameters: [{ type: "payload", payload: rendered.buttons.cancel }],
    },
  ];

  await saveNotificationRenderedVariables(notificationId, {
    body: rendered.body,
    previewText: orderPreview(notification, rendered.body),
    buttonMapping: ["confirmToken", "cancelToken"],
  });

  const retryAfterMs = await acquireBusinessSendPermit(notification.businessProfileId);
  if (retryAfterMs !== null) {
    throw new OrderConfirmationRateLimitError(retryAfterMs);
  }
  await markNotificationAttempted(notificationId);
  const response = await sendWhatsAppTemplate(
    notification.order.customerPhone,
    templateConfig.templateName,
    templateConfig.languageCode,
    components,
    account.phoneNumberId,
    accessToken,
  );
  const providerId = providerMessageId(response);
  const previewText = orderPreview(notification, rendered.body);

  const conversation = await getOrCreateConversation(
    account.phoneNumberId,
    notification.order.customerPhone,
    notification.businessProfileId,
    {
      channel: "whatsapp",
      customerPhone: notification.order.customerPhone,
      customerName: notification.order.customerName ?? undefined,
    },
  );
  await saveMessage(conversation.id, "agent", previewText, {
    externalId: providerId,
    origin: "order_confirmation",
  });

  return { providerMessageId: providerId, previewText };
}

function acknowledgementText(notification: OrderNotificationForSending): string {
  const action = (notification.renderedVariables as { action?: unknown } | null)?.action;
  const confirmed = action === "CONFIRM";
  if (notification.locale === "ar") {
    return confirmed
      ? "تم تأكيد طلبك بنجاح."
      : "تم إلغاء طلبك بنجاح.";
  }
  return confirmed ? "Your order has been confirmed." : "Your order has been canceled.";
}

export async function sendAcknowledgementNotification(notificationId: number): Promise<{
  providerMessageId: string;
  previewText: string;
}> {
  const notification = await findNotificationForSending(notificationId);
  if (!notification) throw new Error("Order notification not found");

  await ensureGlobalAndSuppressionAllowed(notification);

  const account = getAccount(notification);
  const previewText = acknowledgementText(notification);
  const accessToken = decryptFacebookSecret(account.accessToken);
  const retryAfterMs = await acquireBusinessSendPermit(notification.businessProfileId);
  if (retryAfterMs !== null) {
    throw new OrderConfirmationRateLimitError(retryAfterMs);
  }
  await markNotificationAttempted(notificationId);
  const response = await sendWhatsAppReply(
    notification.order.customerPhone,
    previewText,
    account.phoneNumberId,
    accessToken,
  );
  const providerId = providerMessageId(response);

  const conversation = await getOrCreateConversation(
    account.phoneNumberId,
    notification.order.customerPhone,
    notification.businessProfileId,
    {
      channel: "whatsapp",
      customerPhone: notification.order.customerPhone,
      customerName: notification.order.customerName ?? undefined,
    },
  );
  await saveMessage(conversation.id, "agent", previewText, {
    externalId: providerId,
    origin: "order_confirmation",
  });

  return { providerMessageId: providerId, previewText };
}
