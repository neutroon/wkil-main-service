import { Router, Response } from "express";
import prisma from "@config/prisma";
import { processWidgetChatMessage } from "./services/widgetChat.service";
import { listConversationMessages, saveMessage } from "@modules/meta/core/conversation.service";
import type { WidgetRequest } from "@modules/widget/widgetInstall.middleware";
import { widgetInstallAndCors } from "@modules/widget/widgetInstall.middleware";
import { validate } from "@middlewares/validate.middleware";
import {
  widgetChatSchema,
  widgetHistorySchema,
} from "./widget.validation";
import { AppError } from "@middlewares/errorHandler.middleware";

const widgetPublicRoutes = Router();

widgetPublicRoutes.options("/chat", widgetInstallAndCors);
widgetPublicRoutes.options("/config", widgetInstallAndCors);

/**
 * GET /v1/public/widget/config
 * Returns branding and configuration for the widget based on siteKey.
 */
widgetPublicRoutes.get(
  "/config",
  widgetInstallAndCors,
  async (req: WidgetRequest, res: Response) => {
    const install = req.widgetInstall;
    if (!install) {
      throw new AppError("Widget context missing", 500);
    }

    const profile = await prisma.businessProfile.findUnique({
      where: { id: install.businessProfileId },
      select: {
        name: true,
        brandLogoUrl: true,
        brandPrimaryColor: true,
        brandSecondaryColor: true,
        brandAccentColor: true,
        visualAesthetic: true,
        artStyle: true,
      },
    });

    if (!profile) {
      throw new AppError("Business profile not found", 404);
    }

    return res.json({
      branding: {
        name: profile.name,
        logoUrl: profile.brandLogoUrl,
        colors: {
          primary: profile.brandPrimaryColor,
          secondary: profile.brandSecondaryColor,
          accent: profile.brandAccentColor,
        },
        aesthetic: profile.visualAesthetic,
        artStyle: profile.artStyle,
      },
      settings: {
        // Future: add widget-specific settings here (e.g. initial message)
        initialMessage: "Hello! How can I help you today?",
      },
    });
  },
);

widgetPublicRoutes.post(
  "/chat",
  widgetInstallAndCors,
  validate(widgetChatSchema),
  async (req: WidgetRequest, res: Response) => {
    const install = req.widgetInstall;
    if (!install) {
      throw new AppError("Widget context missing", 500);
    }

    const { visitorId, message, conversationId, stream } = req.body;

    if (stream) {
      // ── Server-Sent Events (SSE) Streaming Path ───────────────────────
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const { processWidgetChatStreaming } = await import("./services/widgetChat.service");
      const generator = processWidgetChatStreaming({
        install,
        visitorId: visitorId.trim(),
        message: message.trim(),
        conversationId,
      });

      let finalDecision: any = null;
      let fullContent = "";

      for await (const event of generator) {
        if (event.type === "token") {
          fullContent += event.data;
          res.write(`data: ${JSON.stringify({ token: event.data })}\n\n`);
        } else if (event.type === "conversation_id") {
          res.write(`data: ${JSON.stringify({ conversationId: event.data })}\n\n`);
        } else if (event.type === "final_decision") {
          finalDecision = event.data;
        } else if (event.type === "error") {
          res.write(`data: ${JSON.stringify({ error: event.data.content })}\n\n`);
        }
      }

      // Persist final message (streaming doesn't automatically save model turn)
      if (finalDecision) {
        // Find the conversation again to get the ID (setupWidgetChat creates it if missing)
        // Actually, we should yield the conversationId from the generator too.
        // For now, I'll assume we have it or fetch it.
        const pageId = `widget:${install.id}`;
        const conversation = await prisma.conversation.findFirst({
          where: { pageId, senderId: visitorId },
          orderBy: { updatedAt: "desc" },
        });

        if (conversation) {
          const isAutoMode = req.body.responseMode !== "MANUAL"; // Simplified
          const status = finalDecision.action === "HANDOFF_TO_HUMAN" ? "PENDING_REVIEW" : "SENT";
          
          await saveMessage(conversation.id, "model", finalDecision.content || fullContent, {
            status,
            aiReasoning: finalDecision.reasoning,
            handoffCategory: finalDecision.handoffCategory,
          });

          if (finalDecision.action === "RESOLVE_CONVERSATION") {
            await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "RESOLVED" } });
          }
        }
      }

      res.write("data: [DONE]\n\n");
      return res.end();
    }

    // ── Standard JSON Path ───────────────────────────────────────────
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
  },
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

    const result = await listConversationMessages(convId, 100);
    return res.json({
      conversationId: convId,
      ...result,
    });
  },
);

export default widgetPublicRoutes;







