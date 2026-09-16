import { randomUUID } from "node:crypto";
import prisma from "@config/prisma";
import { emitToBusiness, emitToConversation } from "./socket";
import { logger } from "@utils/logger";

const COEXISTENCE_IMPORT_EVENT_LEASE_MS = 5_000;

export type CoexistenceHistoryImportedInput = {
  businessProfileId: number;
  phoneNumberId: string;
  conversationIds: number[];
  importedMessageCount: number;
  importedContactCount: number;
};

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

async function getOrCreateCoexistenceImportEvent(
  input: CoexistenceHistoryImportedInput,
  eventKey: string,
) {
  const payload = {
    businessProfileId: input.businessProfileId,
    phoneNumberId: input.phoneNumberId,
    conversationIds: input.conversationIds,
    importedMessageCount: input.importedMessageCount,
    importedContactCount: input.importedContactCount,
  };

  try {
    return await prisma.whatsAppCoexistenceImportEvent.create({
      data: {
        businessProfileId: input.businessProfileId,
        phoneNumberId: input.phoneNumberId,
        eventKey,
        payload,
      },
    });
  } catch (error: unknown) {
    if (!isUniqueConstraintError(error)) throw error;

    const existing = await prisma.whatsAppCoexistenceImportEvent.findUnique({
      where: {
        businessProfileId_phoneNumberId_eventKey: {
          businessProfileId: input.businessProfileId,
          phoneNumberId: input.phoneNumberId,
          eventKey,
        },
      },
    });
    if (!existing) {
      throw new Error("Coexistence import event claim disappeared after a unique conflict");
    }
    return existing;
  }
}

function eventPayload(value: unknown): CoexistenceHistoryImportedInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid persisted Coexistence import event payload");
  }
  return value as CoexistenceHistoryImportedInput;
}

/**
 * Notifies the business room after a bounded Coexistence history or contact
 * import completes. Historical messages use the importer origin and are
 * intentionally not emitted through the per-message sync path.
 *
 * The import row is a durable outbox record. A short database lease prevents
 * concurrent workers from emitting the same payload, while an expired lease
 * makes a row reclaimable if a process dies before or during socket delivery.
 * Socket.IO delivery itself remains at-least-once: a crash after delivery and
 * before the delivered marker can cause a duplicate invalidation, which is
 * safe because the event only tells clients to refetch current state.
 */
export const syncCoexistenceHistoryImported = (
  input: CoexistenceHistoryImportedInput,
  eventKey: string,
): Promise<void> => {
  return (async () => {
    const pendingEvent = await getOrCreateCoexistenceImportEvent(input, eventKey);
    if (pendingEvent.deliveredAt) return;

    const leaseToken = randomUUID();
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + COEXISTENCE_IMPORT_EVENT_LEASE_MS);
    const claim = await prisma.whatsAppCoexistenceImportEvent.updateMany({
      where: {
        businessProfileId: input.businessProfileId,
        phoneNumberId: input.phoneNumberId,
        eventKey,
        deliveredAt: null,
        OR: [
          { leaseUntil: null },
          { leaseUntil: { lte: now } },
        ],
      },
      data: {
        leaseToken,
        leaseUntil,
        attempts: { increment: 1 },
      },
    });
    if (claim.count !== 1) return;

    try {
      emitToBusiness(
        input.businessProfileId,
        "whatsapp_history_imported",
        eventPayload(pendingEvent.payload),
      );
      await prisma.whatsAppCoexistenceImportEvent.updateMany({
        where: {
          businessProfileId: input.businessProfileId,
          phoneNumberId: input.phoneNumberId,
          eventKey,
          leaseToken,
          deliveredAt: null,
        },
        data: {
          deliveredAt: new Date(),
          leaseToken: null,
          leaseUntil: null,
        },
      });
    } catch (error: unknown) {
      await prisma.whatsAppCoexistenceImportEvent.updateMany({
        where: {
          businessProfileId: input.businessProfileId,
          phoneNumberId: input.phoneNumberId,
          eventKey,
          leaseToken,
          deliveredAt: null,
        },
        data: {
          leaseToken: null,
          leaseUntil: null,
        },
      }).catch(() => undefined);
      throw error;
    }
  })();
};

/**
 * BEST PRACTICE: Background Socket Synchronization
 * This helper is called by the Prisma Extension to ensure the UI 
 * is always in sync with the database without blocking the DB transaction.
 */
export const syncSocketFromMessage = async (message: any) => {
  if (!message || !message.conversationId) return;

  try {
    // We need the businessProfileId to know which business to notify.
    // In a production app, we try to ensure the message object carries it,
    // or we do a quick background fetch.
    
    // For now, we rely on the message carrying its conversation context 
    // or we fetch it if missing. (Extended in Prisma logic)
    const { conversationId, conversation } = message;
    const businessProfileId = conversation?.businessProfileId;
    const channel = conversation?.channel ?? null;

    if (businessProfileId) {
      // 1. Notify the specific Business Dashboard
      emitToBusiness(businessProfileId, "new_message", {
        conversationId,
        channel,
        message,
      });

      // 2. Notify the specific Conversation Room (Inbox)
      emitToConversation(conversationId, "new_message", {
        conversationId,
        channel,
        message,
      });

      logger.debug("socket.sync.success", { messageId: message.id, businessProfileId });
    }
  } catch (error: any) {
    logger.warn("socket.sync.failed_soft", { error: error.message });
  }
};

/**
 * Synchronizes a persisted human reply and the accompanying transfer to human
 * control. The client merge path is keyed by the durable message ID, so the
 * lightweight socket delivery remains safe if the Prisma write hook also
 * emits the same message.
 */
export const syncManualReply = (params: {
  businessProfileId: number;
  conversationId: number;
  channel: string | null;
  message: any;
}) => {
  const messagePayload = {
    conversationId: params.conversationId,
    channel: params.channel,
    message: params.message,
  };
  emitToBusiness(params.businessProfileId, "new_message", messagePayload);
  emitToConversation(params.conversationId, "new_message", messagePayload);

  const statusPayload = {
    conversationId: params.conversationId,
    messageId: params.message.id,
    status: params.message.status,
    externalId: params.message.externalId,
  };
  emitToBusiness(params.businessProfileId, "message_status_updated", statusPayload);
  emitToBusiness(params.businessProfileId, "message_status", statusPayload);
  emitToBusiness(params.businessProfileId, "ai_toggle_updated", {
    conversationId: params.conversationId,
    aiEnabled: false,
  });
};
/**
 * Handles real-time sync for bulk operations (updateMany) where Prisma 
 * hooks cannot provide the updated objects.
 */
export const syncBulkMessageStatus = (params: {
  businessProfileId: number;
  conversationId: number;
  status: string;
  metadata?: any;
}) => {
  const { businessProfileId, conversationId, status, metadata } = params;

  const payload = {
    conversationId,
    status,
    ...metadata
  };

  emitToBusiness(businessProfileId, "message_status_updated", {
    ...payload
  });
  emitToBusiness(businessProfileId, "message_status", {
    ...payload
  });
  
  logger.debug("socket.bulk_sync.success", { conversationId, status });
};

/**
 * Handles ephemeral typing indicators.
 */
export const syncTypingStatus = (params: {
  businessProfileId: number;
  conversationId: number;
  isTyping: boolean;
}) => {
  const { businessProfileId, conversationId, isTyping } = params;
  
  emitToBusiness(businessProfileId, "customer_typing", {
    conversationId,
    typing: isTyping
  });
};

/**
 * Handles real-time credit/billing updates.
 */
export const syncCreditsUpdate = (params: {
  businessProfileId: number;
  userId: number;
  creditsUsed: number;
  totalCreditsUsed: number;
}) => {
  const { businessProfileId, userId, creditsUsed, totalCreditsUsed } = params;
  
  emitToBusiness(businessProfileId, "credits_updated", {
    userId,
    creditsUsed,
    totalCreditsUsed
  });
};

/**
 * Handles real-time system error alerts.
 */
export const syncSystemError = (params: {
  businessProfileId: number;
  conversationId: number;
  reason: string;
}) => {
  emitToBusiness(params.businessProfileId, "system_critical_error", {
    conversationId: params.conversationId,
    reason: params.reason
  });
};

/**
 * Handles customer-facing AI handoff requests.
 * The message is already saved/sent normally; this is only the admin alert.
 */
export const syncHandoffRequested = (params: {
  businessProfileId: number;
  conversationId: number;
  message: any;
}) => {
  emitToBusiness(params.businessProfileId, "handoff_requested", {
    conversationId: params.conversationId,
    message: params.message,
  });
};

/**
 * Handles background job failure notifications.
 */
export const syncJobStatus = (params: {
  businessProfileId: number;
  jobId: string;
  status: string;
  error?: string;
}) => {
  emitToBusiness(params.businessProfileId, "job_failed", {
    jobId: params.jobId,
    status: params.status,
    error: params.error
  });
};

export const syncIntegrationActionStatus = (params: {
  businessProfileId: number;
  conversationId?: number | null;
  actionRunId: number;
  sourceId: number;
  trigger: string;
  status: string;
}) => {
  const payload = {
    conversationId: params.conversationId ?? null,
    actionRunId: params.actionRunId,
    sourceId: params.sourceId,
    trigger: params.trigger,
    status: params.status,
  };

  emitToBusiness(params.businessProfileId, "integration_action_status", payload);
  if (params.conversationId) {
    emitToConversation(params.conversationId, "integration_action_status", payload);
  }
};

/**
 * Handles real-time visual content updates (e.g., AI images).
 */
export const syncVisualUpdate = (params: {
  businessProfileId: number;
  conversationId?: number;
  postId?: string;
  visualData: any;
}) => {
  emitToBusiness(params.businessProfileId, "visual_updated", {
    conversationId: params.conversationId,
    postId: params.postId,
    ...params.visualData
  });
};

/**
 * Handles media processing/sync status.
 */
export const syncMediaStatus = (params: {
  businessProfileId: number;
  assetId: number;
  status: string;
  platform?: string;
  identifier?: string;
  url?: string;
}) => {
  emitToBusiness(params.businessProfileId, "media_sync_status", {
    assetId: params.assetId,
    status: params.status,
    platform: params.platform,
    identifier: params.identifier,
    url: params.url
  });
};

export { emitToBusiness, emitToConversation };
