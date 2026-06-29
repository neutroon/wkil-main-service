import prisma from "@config/prisma";
import { env } from "@config/env";
import { logger } from "@utils/logger";
import {
  deleteDeviceTokens,
  listActiveTokensForBusiness,
} from "./deviceToken.service";
import { sendMulticast } from "./fcm.service";

/**
 * Build the per-conversation "uid" the mobile app uses for routing.
 * Mirrors `Conversation.uid` on the mobile side (channel + id joined
 * with `-`), so the deep link `/inbox/thread?uid=...` resolves
 * directly to the existing thread screen.
 */
export function buildConversationUid(channel: string, id: number): string {
  return `${channel}-${id}`;
}

/**
 * Build the FCM payload for a handoff push and fan it out to every
 * active device that belongs to a user owning the target business.
 *
 * This function is BEST-EFFORT. It NEVER throws. A handoff decision
 * must not be rolled back because FCM is down.
 *
 * Flow:
 *   1. Resolve all active FCM tokens for users of this business.
 *   2. Look up the conversation's `channel` + customer's last
 *      message preview (one DB round-trip).
 *   3. Build the localized notification + data payload.
 *   4. Call FCM `sendMulticast`.
 *   5. Garbage-collect any tokens FCM reported as dead.
 *   6. Log a single structured event with the outcome.
 */
export async function sendHandoffPush(params: {
  businessProfileId: number;
  conversationId: number;
  handoffCategory: string;
  /** Localized strings — backend serves whatever locale the device asked for. */
  locale: "en" | "ar";
}): Promise<void> {
  try {
    const tokens = await listActiveTokensForBusiness({
      businessProfileId: params.businessProfileId,
    });

    // Look up the conversation + last customer message preview in one
    // round-trip. We do this even if there are no tokens so the log
    // line below can record `conversationUid`.
    const [conversation, lastCustomerMsg] = await Promise.all([
      prisma.conversation.findUnique({
        where: { id: params.conversationId },
        select: { channel: true },
      }),
      prisma.conversationMessage.findFirst({
        where: { conversationId: params.conversationId, role: "user" },
        orderBy: { createdAt: "desc" },
        select: { content: true },
      }),
    ]);

    if (!conversation) {
      logger.warn("handoff_push.conversation_missing", {
        conversationId: params.conversationId,
        businessProfileId: params.businessProfileId,
      });
      return;
    }

    const channel = conversation.channel ?? "web";
    const conversationUid = buildConversationUid(channel, params.conversationId);
    const preview = lastCustomerMsg?.content?.trim() ?? null;

    if (tokens.length === 0) {
      logger.info("handoff_push.no_recipients", {
        businessProfileId: params.businessProfileId,
        conversationId: params.conversationId,
        conversationUid,
      });
      return;
    }

    const strings = pickStrings(params.locale);
    const data: Record<string, string> = {
      type: "handoff_request",
      conversation_id: String(params.conversationId),
      conversation_uid: conversationUid,
      business_id: String(params.businessProfileId),
      handoff_category: params.handoffCategory,
      // Pass the locale so the mobile client can render the in-app
      // banner with the same wording if it lands while the app is
      // foregrounded.
      locale: params.locale,
    };
    // `notification` + `data` together: notification guarantees the OS
    // shows a banner even on a terminated app; data carries the
    // routing payload the app reads on tap.
    const result = await sendMulticast({
      tokens,
      notification: {
        title: strings.title,
        body: preview ? truncate(preview, 120) : strings.defaultBody,
      },
      data,
      android: {
        channelId: "handoff_requests",
        priority: "high",
        visibility: "public",
      },
      apns: {
        pushType: "alert",
        // `category` is reserved here for v2 action buttons
        // (HANDOFF_REQUEST). v1 only shows the default tap-to-open
        // behavior.
        sound: "default",
        mutableContent: false,
      },
    });

    // Reap dead tokens reported by FCM. Best-effort.
    if (result.deadTokens.length > 0) {
      await deleteDeviceTokens(result.deadTokens).catch((err: unknown) =>
        logger.warn("handoff_push.dead_token_cleanup_failed", {
          error: err instanceof Error ? err.message : String(err),
          count: result.deadTokens.length,
        }),
      );
    }

    logger.info("handoff_push.dispatched", {
      businessProfileId: params.businessProfileId,
      conversationId: params.conversationId,
      conversationUid,
      locale: params.locale,
      attempted: result.attempted,
      success: result.successCount,
      failed: result.failureCount,
      deadTokens: result.deadTokens.length,
      fcmEnabled: env.FCM_ENABLED,
    });
  } catch (err) {
    // Swallow + log. Push is never on the critical path for a
    // handoff decision.
    logger.error("handoff_push.unhandled_error", {
      businessProfileId: params.businessProfileId,
      conversationId: params.conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── i18n ──────────────────────────────────────────────────────────────────

type HandoffStrings = {
  title: string;
  defaultBody: string;
};

function pickStrings(locale: "en" | "ar"): HandoffStrings {
  // v1 strings. The category is in `data` so the mobile app can
  // re-render with the right label once the user opens the thread.
  if (locale === "ar") {
    return {
      title: "طلب تسليم بشري",
      defaultBody: "يحتاج العميل التحدث مع موظف",
    };
  }
  return {
    title: "Handoff requested",
    defaultBody: "Customer needs a human",
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}
