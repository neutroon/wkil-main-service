import { Router, Response } from "express";
import { randomUUID } from "node:crypto";
import multer from "multer";
import prisma from "@config/prisma";
import {
  completeWidgetChatMessage,
  failWidgetChatMessage,
  prepareWidgetChatMessage,
  processWidgetChatMessage,
  type PreparedWidgetChat,
} from "./services/widgetChat.service";
import { AgentClient } from "@modules/ai-agent/client/agent.client";
import { mergeVisitorConversations } from "./services/widgetMigration.service";
import { listConversationMessages } from "@modules/meta/core/conversation.service";
import type { WidgetRequest } from "@modules/widget/widgetInstall.middleware";
import { widgetInstallAndCors } from "@modules/widget/widgetInstall.middleware";
import { validate } from "@middlewares/validate.middleware";
import { logger } from "@utils/logger";
import {
  widgetChatSchema,
  widgetMediaChatSchema,
  widgetHistorySchema,
} from "./widget.validation";
import { AppError } from "@middlewares/errorHandler.middleware";
import { verifyWidgetUserFromRequest } from "./services/widgetIdentity.service";

const widgetPublicRoutes = Router();
const widgetMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

function normalizeWidgetText(input: string): string {
  return input
    .replace(/[\uFE00-\uFE0F\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function writeSseData(res: Response, payload: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeSseDone(res: Response): void {
  if (res.destroyed || res.writableEnded) return;
  res.write("data: [DONE]\n\n");
  res.end();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function widgetErrorCode(error: unknown): string {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
  if (code === "CUSTOMER_AGENT_RUN_ABORTED") return code;
  if (error instanceof Error && /timeout/i.test(error.message)) return "CUSTOMER_AGENT_TIMEOUT";
  return "CUSTOMER_AGENT_FAILURE";
}

function isPreparedRun(value: PreparedWidgetChat): value is Exclude<PreparedWidgetChat, { result: unknown }> {
  return "handle" in value;
}

widgetPublicRoutes.options("/chat", widgetInstallAndCors);
widgetPublicRoutes.options("/chat/media", widgetInstallAndCors);
widgetPublicRoutes.options("/config", widgetInstallAndCors);

/**
 * GET /v1/public/widget/config
 * Returns branding and configuration for the widget based on siteKey.
 * Install-level settings override BusinessProfile brand kit.
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

    // Parse install-level settings overrides
    const s = (install.settings ?? null) as Record<string, any> | null;

    return res.json({
      branding: {
        name: s?.headerTitle ?? profile.name,
        logoUrl: s?.logoUrl ?? profile.brandLogoUrl,
        colors: {
          primary: s?.colors?.primary ?? profile.brandPrimaryColor,
          secondary: s?.colors?.secondary ?? profile.brandSecondaryColor,
          accent: s?.colors?.accent ?? profile.brandAccentColor,
        },
        position: s?.position ?? "bottom-right",
        headerSubtitle: s?.headerSubtitle ?? null,
        welcomeMessage: s?.welcomeMessage ?? null,
        launcherStyle: s?.launcherStyle ?? "rounded",
        greetingDelayMs: s?.greetingDelayMs ?? 5000,
        showBranding: s?.showBranding !== false,
        aesthetic: profile.visualAesthetic,
        artStyle: profile.artStyle,
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

    const { visitorId, message, conversationId, stream, user } = req.body;
    const normalizedMessage = normalizeWidgetText(message);
    if (!normalizedMessage) {
      throw new AppError("message is required", 400);
    }

    const verifiedUser = verifyWidgetUserFromRequest(
      install.identitySecret,
      user,
    );

    const runChat = () =>
      processWidgetChatMessage({
        install,
        visitorId: visitorId.trim(),
        message: normalizedMessage,
        conversationId,
        verifiedUser: verifiedUser ?? undefined,
      });

    if (stream === true) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      const controller = new AbortController();
      let clientClosed = false;
      let remoteRunTerminal = false;
      let remoteRunCompleted = false;
      let cancelRequested = false;
      let preparedRun: PreparedWidgetChat | null = null;
      const correlationId = randomUUID();
      const cancelPreparedRun = () => {
        if (!cancelRequested && !remoteRunTerminal && !remoteRunCompleted && preparedRun && isPreparedRun(preparedRun)) {
          cancelRequested = true;
          Promise.resolve(AgentClient.cancelCustomerRun(preparedRun.handle.threadId, preparedRun.handle.runId))
            .catch((error) => logger.warn("widget.chat.cancel_failed", {
              widgetInstallId: install.id,
              businessProfileId: install.businessProfileId,
              errorCode: widgetErrorCode(error),
              correlationId,
            }));
        }
      };
      const onClose = () => {
        clientClosed = true;
        controller.abort(new Error("widget client disconnected"));
        cancelPreparedRun();
      };
      req.on("close", onClose);
      // Once the request body has been fully read, Node may only signal a
      // browser-disconnected SSE response through the response socket.
      res.on("close", onClose);

      try {
        writeSseData(res, { status: "processing" });
        preparedRun = await prepareWidgetChatMessage({
          install,
          visitorId: visitorId.trim(),
          message: normalizedMessage,
          conversationId,
          verifiedUser: verifiedUser ?? undefined,
        }, controller.signal);
        if (clientClosed) {
          cancelPreparedRun();
          throw new Error("Widget client disconnected before the customer run stream joined");
        }

        let result;
        if (preparedRun.result) {
          result = preparedRun.result;
          remoteRunCompleted = true;
        } else {
          let streamEndedNaturally = true;
          for await (const event of AgentClient.joinCustomerRunStream(
            preparedRun.handle.threadId,
            preparedRun.handle.runId,
            { signal: controller.signal, cancelOnDisconnect: true },
          )) {
            if (clientClosed) {
              streamEndedNaturally = false;
              break;
            }
            writeSseData(res, { status: "processing", event: event.event });
          }
          if (!streamEndedNaturally) {
            throw controller.signal.reason ?? new Error("Widget client disconnected before the customer run completed");
          }
          // A naturally exhausted exact-run stream is terminal. The final
          // state read below must finish even if the client closes in this
          // small gap; otherwise cancellation can race a completed remote
          // run and rewrite its durable turn as FAILED.
          remoteRunTerminal = true;
          // Values frames are snapshots, not completion signals. Consume the
          // stream fully, then use the SDK's exact-run join to verify success
          // and obtain the final persisted structured response. Joined stream
          // output is intentionally unbuffered.
          const decision = await AgentClient.joinCustomerRun(
            preparedRun.handle.threadId,
            preparedRun.handle.runId,
          );
          remoteRunCompleted = true;
          result = await completeWidgetChatMessage(preparedRun, decision);
        }
        if (!clientClosed) {
          writeSseData(res, {
            final: {
              reply: result.reply,
              action: result.action,
              attachment: result.attachment ?? null,
              conversationId: result.conversationId,
            },
          });
        }
      } catch (error) {
        if (
          preparedRun &&
          isPreparedRun(preparedRun) &&
          !remoteRunCompleted
        ) {
          await Promise.resolve(failWidgetChatMessage(preparedRun, error)).catch((finalizeError) => {
            logger.warn("widget.chat.finalize_failed", {
              widgetInstallId: install.id,
              businessProfileId: install.businessProfileId,
              errorCode: widgetErrorCode(finalizeError),
              correlationId,
            });
          });
        }
        logger.error("widget.chat.stream_failed", {
          widgetInstallId: install.id,
          businessProfileId: install.businessProfileId,
          errorCode: widgetErrorCode(error),
          correlationId,
        });
        if (!clientClosed) {
          writeSseData(res, {
            error: "Unable to complete chat response.",
          });
        }
      }

      req.off("close", onClose);
      res.off("close", onClose);
      if (!clientClosed) {
        writeSseDone(res);
      }
      return;
    }

    // ── Standard JSON Path ───────────────────────────────────────────
    const result = await runChat();

    return res.json(result);
  },
);

widgetPublicRoutes.post(
  "/chat/media",
  widgetInstallAndCors,
  widgetMediaUpload.single("file"),
  validate(widgetMediaChatSchema),
  async (req: WidgetRequest, res: Response) => {
    const install = req.widgetInstall;
    if (!install) {
      throw new AppError("Widget context missing", 500);
    }
    if (!req.file) {
      throw new AppError("file is required", 400);
    }

    const { visitorId, message = "", conversationId } = req.body;
    const normalizedMessage = normalizeWidgetText(String(message || ""));

    const result = await processWidgetChatMessage({
      install,
      visitorId: visitorId.trim(),
      message: normalizedMessage,
      conversationId,
      media: {
        buffer: req.file.buffer,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
      },
    });

    return res.json(result);
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

    const { visitorId, conversationId: qConvId, previousVisitorId } = req.query as {
      visitorId: string;
      conversationId?: string;
      previousVisitorId?: string;
    };

    const pageId = `widget:${install.id}`;

    // Step 1: Handle identity migration/merge BEFORE looking up conversations
    let migratedConvId: number | undefined;
    if (previousVisitorId && previousVisitorId !== visitorId) {
      migratedConvId = await mergeVisitorConversations(
        pageId,
        visitorId,
        previousVisitorId,
      );
    }

    // Step 2: Resolve the conversation ID
    let convId: number | undefined;

    if (migratedConvId) {
      // Migration happened — use the surviving conversation
      convId = migratedConvId;
    } else if (qConvId) {
      convId = parseInt(qConvId, 10);
    } else {
      // Automatic discovery: find latest conversation for this visitor
      const latest = await prisma.conversation.findFirst({
        where: { senderId: visitorId, pageId, channel: "web" },
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
      where: { id: convId, pageId, senderId: visitorId },
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
