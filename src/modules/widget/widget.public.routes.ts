import { Router, Response } from "express";
import prisma from "@config/prisma";
import { processWidgetChatMessage } from "./services/widgetChat.service";
import { listConversationMessages } from "@modules/meta/core/conversation.service";
import type { WidgetRequest } from "@modules/widget/widgetInstall.middleware";
import { widgetInstallAndCors } from "@modules/widget/widgetInstall.middleware";
import { validate } from "@middlewares/validate.middleware";
import {
  widgetChatSchema,
  widgetHistorySchema,
} from "./widget.validation";
import { AppError } from "@middlewares/errorHandler.middleware";

const widgetPublicRoutes = Router();

function normalizeWidgetText(input: string): string {
  return input
    .replace(/[\uFE00-\uFE0F\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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
    const normalizedMessage = normalizeWidgetText(message);
    if (!normalizedMessage) {
      throw new AppError("message is required", 400);
    }

    if (stream) {
      // ── Server-Sent Events Path ────────────────────────────────────────
      // We keep SSE for progress/final delivery, but use the same approved
      // non-streaming chat flow as Messenger/WhatsApp to avoid exposing
      // unverified partial tokens before final guardrails.
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      try {
        res.write(`data: ${JSON.stringify({ status: "processing" })}\n\n`);
        const result = await processWidgetChatMessage({
          install,
          visitorId: visitorId.trim(),
          message: normalizedMessage,
          conversationId,
        });

        res.write(
          `data: ${JSON.stringify({
            final: {
              reply: result.reply,
              action: "REPLY_AUTO",
              attachment: result.attachment ?? null,
              conversationId: result.conversationId,
            },
          })}\n\n`,
        );
      } catch (err) {
        res.write(
          `data: ${JSON.stringify({
            error: err instanceof Error ? err.message : "Unable to complete chat response.",
          })}\n\n`,
        );
      }

      res.write("data: [DONE]\n\n");
      return res.end();
    }

    // ── Standard JSON Path ───────────────────────────────────────────
    const result = await processWidgetChatMessage({
      install,
      visitorId: visitorId.trim(),
      message: normalizedMessage,
      conversationId,
    });

    return res.json({
      reply: result.reply,
      conversationId: result.conversationId,
      attachment: result.attachment ?? null,
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







