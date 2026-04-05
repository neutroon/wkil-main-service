import { Router, Response } from "express";
import { processWidgetChatMessage } from "../services/widget/widgetChat.service";
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

export default widgetPublicRoutes;
