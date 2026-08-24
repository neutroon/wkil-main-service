import { logger } from "@utils/logger";
import { listCopilotMessages, updateConversationTitle } from "./copilot.store";

/**
 * Best-effort auto-title for a copilot conversation. Fires fire-and-forget
 * after the first assistant response in a conversation. Skips when the
 * conversation already has a title (whether user-set or auto-set previously).
 *
 * Failures are logged via `logger.warn` (with `conversationId`/`userId`
 * context) instead of being silently swallowed — the previous behavior made
 * the "all conversations named 'New chat'" bug invisible in production.
 */
export function maybeAutoTitle(
  conversationId: number,
  userId: number,
  currentTitle: string | null | undefined,
): void {
  if (currentTitle) return;
  void (async () => {
    try {
      const recent = await listCopilotMessages(conversationId, 50);
      const firstUser = recent.find((m) => m.role === "USER");
      if (firstUser && (firstUser.envelope as any)?.type === "text") {
        const fullText = (firstUser.envelope as any).text as string;
        const truncated = fullText.length > 50 ? `${fullText.slice(0, 50)}…` : fullText;
        await updateConversationTitle(conversationId, userId, truncated);
      }
    } catch (error) {
      logger.warn("copilot.auto_title_failed", {
        conversationId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}
