import { emitToBusiness, emitToConversation } from "./socket";
import { logger } from "@utils/logger";

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

    if (businessProfileId) {
      // 1. Notify the specific Business Dashboard
      emitToBusiness(businessProfileId, "new_message", {
        conversationId,
        message,
      });

      // 2. Notify the specific Conversation Room (Inbox)
      emitToConversation(conversationId, "new_message", {
        message,
      });

      logger.debug("socket.sync.success", { messageId: message.id, businessProfileId });
    }
  } catch (error: any) {
    logger.warn("socket.sync.failed_soft", { error: error.message });
  }
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
  
  emitToBusiness(businessProfileId, "message_status_updated", {
    conversationId,
    status,
    ...metadata
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



