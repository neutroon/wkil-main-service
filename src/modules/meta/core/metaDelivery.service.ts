import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { getOrCreateConversation, saveMessage } from "../core/conversation.service";

/**
 * ELITE TIER: Selective Mirroring (Inbox Continuity)
 * Mirrors a private reply from a comment thread to the main Messenger thread.
 */
export const mirrorCommentReplyToMessenger = async (params: {
  pageId: string;
  senderId: string;
  businessProfileId: number;
  messageId: string;
  content: string;
  intent?: string;
  reasoning?: string;
  postId?: string;
  commentId?: string;
  role?: "model" | "agent";
}) => {
  const {
    pageId,
    senderId,
    businessProfileId,
    messageId,
    content,
    intent,
    reasoning,
    postId,
    commentId,
    role = "agent",
  } = params;

  if (!messageId || messageId === "ALREADY_REPLIED") return null;

  try {
    const messengerConv = await getOrCreateConversation(
      pageId,
      senderId,
      businessProfileId,
      { channel: "messenger" }
    );

    const mirrorId = `mirror_${messageId}`;
    const existingMirror = await prisma.conversationMessage.findUnique({
      where: { externalId: mirrorId },
    });

    if (!existingMirror) {
      const mirroredMsg = await saveMessage(messengerConv.id, role, content, {
        externalId: mirrorId,
        intent,
        aiReasoning: reasoning,
        isPrivate: true,
        origin: "facebook_comment_reply",
        mediaMetadata: {
          origin: "facebook_comment_reply",
          postId,
          commentId,
        },
      });

      logger.info("meta.delivery.mirror_created", {
        messengerConvId: messengerConv.id,
        messageId: mirrorId,
      });
      return mirroredMsg;
    }
    return existingMirror;
  } catch (error: any) {
    logger.warn("meta.delivery.mirror_failed_soft", { error: error.message });
    return null;
  }
};

/**
 * Updates a message status. 
 * NOTE: Socket emission is handled AUTOMATICALLY by the Prisma Extension.
 */
export const syncMessageStatus = async (
  messageId: number,
  businessProfileId: number,
  conversationId: number,
  updates: { status?: string; externalId?: string }
) => {
  try {
    const updated = await prisma.conversationMessage.update({
      where: { id: messageId },
      data: updates,
    });

    return updated;
  } catch (error: any) {
    logger.error("meta.delivery.sync_failed", { messageId, error: error.message });
    return null;
  }
};




