import { Request, Response } from "express";
import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { listConversationMessages } from "@modules/meta/core/conversation.service";
import { sendMessengerAction } from "@modules/meta/messenger/messenger.service";
import { AppError } from "@middlewares/errorHandler.middleware";

export class ConversationsController {
  /**
   * Verify that the given conversation belongs to the authenticated user,
   * using businessProfileId as the channel-agnostic ownership check.
   * Throws 404 if not found or not owned.
   */
  async getAuthorizedConversation(userId: number, conversationId: number) {
    const profiles = await prisma.businessProfile.findMany({
      where: { userId },
      select: { id: true },
    });
    const profileIds = profiles.map((p) => p.id);

    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, businessProfileId: { in: profileIds } },
    });

    if (!conversation)
      throw new AppError("Conversation not found or access denied.", 404);
    return conversation;
  }

  /**
   * GET /v1/meta/conversations/:id/messages
   */
  async listMessages(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;
    const { limit, cursor } = req.query as any;

    const conversation = await this.getAuthorizedConversation(
      userId,
      conversationId,
    );
    const result = await listConversationMessages(
      conversationId,
      limit,
      cursor,
    );

    const accounts = await prisma.whatsAppAccount.findMany({
      where: { phoneNumberId: conversation.pageId, userId },
      select: { displayPhoneNumber: true },
    });

    return res.json({
      conversation: {
        ...conversation,
        displayPhoneNumber:
          accounts[0]?.displayPhoneNumber ?? conversation.pageId,
        customerPhone: conversation.customerPhone ?? conversation.senderId,
      },
      ...result,
    });
  }

  /**
   * PATCH /v1/meta/conversations/:id/read
   */
  async markRead(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;

    const conversation = await this.getAuthorizedConversation(
      userId,
      conversationId,
    );

    if (conversation.channel === "messenger") {
      const page = await prisma.facebookPage.findFirst({
        where: { pageId: conversation.pageId, isActive: true },
        select: { pageAccessToken: true },
      });
      if (page) {
        const token = decryptFacebookSecret(page.pageAccessToken);
        await sendMessengerAction(
          conversation.senderId,
          "mark_seen",
          token,
        ).catch((e) =>
          logger.warn("meta.read_signal_failed", {
            conversationId,
            error: e.message,
          }),
        );
      }
    }

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { readAt: new Date() },
    });

    return res.json({ success: true });
  }

  /**
   * POST /v1/meta/conversations/:id/typing
   */
  async sendTypingSignal(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;
    const { typing } = req.body as { typing: boolean };

    const conversation = await this.getAuthorizedConversation(
      userId,
      conversationId,
    );

    if (conversation.channel === "messenger") {
      const page = await prisma.facebookPage.findFirst({
        where: { pageId: conversation.pageId, isActive: true },
        select: { pageAccessToken: true },
      });
      if (page) {
        const token = decryptFacebookSecret(page.pageAccessToken);
        await sendMessengerAction(
          conversation.senderId,
          typing ? "typing_on" : "typing_off",
          token,
        ).catch((e) =>
          logger.warn("meta.typing_signal_failed", {
            conversationId,
            error: e.message,
          }),
        );
      }
    }

    return res.json({ success: true });
  }

  /**
   * PATCH /v1/meta/conversations/:id/ai-toggle
   */
  async toggleAi(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;
    const { enabled } = req.body;

    await this.getAuthorizedConversation(userId, conversationId);

    const updated = await prisma.conversation.update({
      where: { id: conversationId },
      data: { aiEnabled: enabled },
    });
    await prisma.user.updateMany({
      where: { id: userId, setupAgentConfiguredAt: null },
      data: { setupAgentConfiguredAt: new Date() },
    });

    logger.info("meta.conversation.ai_toggle", {
      conversationId,
      enabled,
      userId,
    });
    return res.json({ data: updated });
  }

  /**
   * PATCH /v1/meta/conversations/:id/status
   */
  async updateStatus(req: Request, res: Response) {
    const userId = (req as any).user.id as number;
    const { id: conversationId } = req.params as any;
    const { status } = req.body;

    await this.getAuthorizedConversation(userId, conversationId);

    const updated = await prisma.conversation.update({
      where: { id: conversationId },
      data: { status },
    });

    return res.json({ data: updated });
  }

  /**
   * DELETE /v1/meta/conversations/:id
   */
  async deleteConversation(req: Request, res: Response) {
    const user = (req as any).user;
    const isAdmin = user.role === "admin" || user.role === "super_admin";

    if (!isAdmin)
      throw new AppError("Only admins can perform a hard delete.", 403);

    const { id: conversationId } = req.params as any;
    await this.getAuthorizedConversation(user.id, conversationId);

    await prisma.conversation.delete({ where: { id: conversationId } });
    return res.json({ success: true, message: "Conversation deleted." });
  }
}

export const conversationsController = new ConversationsController();
