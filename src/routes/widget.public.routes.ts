import { Router, Response } from "express";
import prisma from "../config/prisma";
import { processWidgetChatMessage } from "../services/widget/widgetChat.service";
import { listConversationMessages } from "../services/meta/conversation.service";
import type { WidgetRequest } from "../middlewares/widgetInstall.middleware";
import { widgetInstallAndCors } from "../middlewares/widgetInstall.middleware";

const widgetPublicRoutes = Router();

const VISITOR_ID_MAX = 128;
const MESSAGE_MAX = 4000;

widgetPublicRoutes.options("/chat", widgetInstallAndCors);

widgetPublicRoutes.post(
  "/chat",
  widgetInstallAndCors,
  async (req: WidgetRequest, res: Response) => {
    try {
      const install = req.widgetInstall;
      if (!install) {
        return res.status(500).json({ error: "Widget context missing" });
      }

      const { visitorId, message, conversationId } = req.body as {
        visitorId?: string;
        message?: string;
        conversationId?: number;
      };

      if (
        !visitorId ||
        typeof visitorId !== "string" ||
        visitorId.length < 8 ||
        visitorId.length > VISITOR_ID_MAX
      ) {
        return res.status(400).json({
          error:
            "visitorId is required (8–128 chars). Use a stable UUID from localStorage.",
        });
      }

      if (
        !message ||
        typeof message !== "string" ||
        !message.trim() ||
        message.length > MESSAGE_MAX
      ) {
        return res.status(400).json({
          error: `message is required (max ${MESSAGE_MAX} characters)`,
        });
      }

      if (
        conversationId !== undefined &&
        (typeof conversationId !== "number" || !Number.isFinite(conversationId))
      ) {
        return res.status(400).json({ error: "conversationId must be a number" });
      }

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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Invalid conversationId")) {
        return res.status(400).json({ error: msg });
      }
      return res.status(500).json({ error: "Chat failed" });
    }
  },
);

/**
 * GET /v1/public/widget/chat/history
 * Retrieve past messages for a visitor.
 */
widgetPublicRoutes.get(
  "/chat/history",
  widgetInstallAndCors,
  async (req: WidgetRequest, res: Response) => {
    try {
      const install = req.widgetInstall;
      if (!install) {
        return res.status(500).json({ error: "Widget context missing" });
      }

      const { visitorId, conversationId: qConvId } = req.query as {
        visitorId?: string;
        conversationId?: string;
      };

      if (!visitorId || typeof visitorId !== "string") {
        return res.status(400).json({ error: "visitorId is required" });
      }

      let convId: number | undefined;
      if (qConvId) {
        convId = parseInt(qConvId, 10);
        if (isNaN(convId)) {
          return res.status(400).json({ error: "conversationId must be a number" });
        }
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
        return res.status(404).json({ error: "Conversation not found" });
      }

      const result = await listConversationMessages(convId, 1, 100);
      return res.json({
        conversationId: convId,
        ...result,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: msg });
    }
  },
);

export default widgetPublicRoutes;
