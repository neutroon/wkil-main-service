import { Router, Response, Request } from "express";
import prisma from "../config/prisma";
import { processWidgetChatMessage } from "../services/widget/widgetChat.service";
import { listConversationMessages } from "../services/meta/conversation.service";
import type { WidgetRequest } from "../middlewares/widgetInstall.middleware";
import { widgetInstallAndCors } from "../middlewares/widgetInstall.middleware";
import { validate } from "../middlewares/validate.middleware";
import { widgetChatSchema, widgetHistorySchema } from "../validations/widget.validation";
import { AppError } from "../middlewares/errorHandler.middleware";

const widgetPublicRoutes = Router();

widgetPublicRoutes.options("/chat", widgetInstallAndCors);

widgetPublicRoutes.post(
  "/chat",
  widgetInstallAndCors,
  validate(widgetChatSchema),
  async (req: WidgetRequest, res: Response) => {
    const install = req.widgetInstall;
    if (!install) {
      throw new AppError("Widget context missing", 500);
    }

    const { visitorId, message, conversationId } = req.body;

    const result = await processWidgetChatMessage({
      install,
      visitorId: visitorId.trim(),
      message: message.trim(),
      conversationId,
    });

    return res.json({
      reply: result.reply,
      conversationId: result.conversationId,
    });
  }
);

/**
 * GET /v1/public/widget/chat/history
 * Retrieve past messages for a visitor.
 */
widgetPublicRoutes.get(
  "/chat/history",
  widgetInstallAndCors,
  validate(widgetHistorySchema),
  async (req: WidgetRequest, res: Response) => {
    const install = req.widgetInstall;
    if (!install) {
      throw new AppError("Widget context missing", 500);
    }

    const { visitorId, conversationId: qConvId } = req.query as {
      visitorId: string;
      conversationId?: string;
    };

    let convId: number | undefined;
    if (qConvId) {
      convId = parseInt(qConvId, 10);
    } else {
      // Automatic discovery: find latest conversation for this visitor on this site
      const latest = await prisma.conversation.findFirst({
        where: {
          senderId: visitorId,
          pageId: `widget:${install.id}`,
          channel: "web",
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      });
      if (latest) {
        convId = latest.id;
      }
    }

    if (!convId) {
      // No conversation yet, return empty list (not an error)
      return res.json({ conversationId: null, data: [], meta: { total: 0 } });
    }

    // Verify ownership (important for security)
    const conversation = await prisma.conversation.findFirst({
      where: {
        id: convId,
        pageId: `widget:${install.id}`,
        senderId: visitorId,
      },
    });

    if (!conversation) {
      throw new AppError("Conversation not found", 404);
    }

    const result = await listConversationMessages(convId, 1, 100);
    return res.json({
      conversationId: convId,
      ...result,
    });
  }
);

export default widgetPublicRoutes;

export default widgetPublicRoutes;
