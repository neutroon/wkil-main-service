import { logger } from "@utils/logger";
import { deleteDeviceTokens, listActiveTokensForBusiness } from "./deviceToken.service";
import { sendMulticast } from "./fcm.service";

type OrderConfirmationStatus = "CONFIRMED" | "CANCELED";

type OrderConfirmationStrings = {
  title: string;
  body: string;
};

/**
 * Sends a generic status alert to active devices in the business workspace.
 * Push delivery is best-effort and never affects the order action result.
 */
export async function sendOrderConfirmationPush(params: {
  businessProfileId: number;
  orderId: number;
  status: OrderConfirmationStatus;
  locale: string;
}): Promise<void> {
  try {
    const tokens = await listActiveTokensForBusiness({
      businessProfileId: params.businessProfileId,
    });

    if (tokens.length === 0) {
      logger.info("order_confirmation.push_no_recipients", {
        businessProfileId: params.businessProfileId,
        orderId: params.orderId,
        status: params.status,
      });
      return;
    }

    const strings = pickStrings(params.status, params.locale);
    const result = await sendMulticast({
      tokens,
      notification: strings,
      data: {
        type: "order_confirmation",
        order_id: String(params.orderId),
        business_id: String(params.businessProfileId),
        status: params.status,
      },
      android: {
        channelId: "order_confirmations",
        priority: "high",
        visibility: "private",
      },
      apns: { pushType: "alert", sound: "default" },
    });

    if (result.deadTokens.length > 0) {
      await deleteDeviceTokens(result.deadTokens).catch((error: unknown) => {
        logger.warn("order_confirmation.push_dead_token_cleanup_failed", {
          businessProfileId: params.businessProfileId,
          count: result.deadTokens.length,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    logger.info("order_confirmation.push_dispatched", {
      businessProfileId: params.businessProfileId,
      orderId: params.orderId,
      status: params.status,
      locale: normalizeLocale(params.locale),
      attempted: result.attempted,
      success: result.successCount,
      failed: result.failureCount,
      deadTokens: result.deadTokens.length,
    });
  } catch (error) {
    logger.error("order_confirmation.push_unhandled_error", {
      businessProfileId: params.businessProfileId,
      orderId: params.orderId,
      status: params.status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeLocale(locale: string): "en" | "ar" {
  return locale.trim().toLowerCase().startsWith("ar") ? "ar" : "en";
}

function pickStrings(
  status: OrderConfirmationStatus,
  locale: string,
): OrderConfirmationStrings {
  const arabic = normalizeLocale(locale) === "ar";
  if (status === "CONFIRMED") {
    return arabic
      ? { title: "تم تأكيد الطلب", body: "أكد أحد العملاء طلبًا." }
      : { title: "Order confirmed", body: "A customer confirmed an order." };
  }
  return arabic
    ? { title: "تم إلغاء الطلب", body: "ألغى أحد العملاء طلبًا." }
    : { title: "Order canceled", body: "A customer canceled an order." };
}
