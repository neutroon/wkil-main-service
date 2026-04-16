import { Router, Request, Response } from "express";
import { randomBytes } from "crypto";
import prisma from "../config/prisma";
import { authenticateToken } from "../middlewares/auth.middleware";
import { parseAllowedOrigins } from "../middlewares/widgetInstall.middleware";
import {
  listConversationMessages,
  saveMessage,
} from "../services/meta/conversation.service";
import { emitToConversation, emitToBusiness } from "../utils/socket";
import { computeBusinessChatReply } from "../services/chat/businessChatReply.service";
import { toPromptMessages, historyToLlmTurns } from "../services/chat/conversationTurns";
import { getConversationHistory } from "../services/meta/conversation.service";
import { logger } from "../utils/logger";

const widgetRoutes = Router();

widgetRoutes.use(authenticateToken);

function newPublicSiteKey(): string {
  return `wsk_${randomBytes(24).toString("base64url")}`;
}

async function authorizeProfile(
  userId: number,
  businessProfileId: number,
): Promise<boolean> {
  const p = await prisma.businessProfile.findFirst({
    where: { id: businessProfileId, userId },
  });
  return Boolean(p);
}

/** POST /v1/widget/installs — create widget; returns publicSiteKey for embed. */
widgetRoutes.post("/installs", async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id as number;
    const { businessProfileId, allowedOrigins, label } = req.body as {
      businessProfileId?: number;
      allowedOrigins?: unknown;
      label?: string;
    };

    if (
      businessProfileId === undefined ||
      typeof businessProfileId !== "number"
    ) {
      return res.status(400).json({ error: "businessProfileId is required" });
    }

    const origins = parseAllowedOrigins(allowedOrigins);
    if (origins.length === 0) {
      return res.status(400).json({
        error:
          "allowedOrigins must be a non-empty array of origin strings (e.g. https://example.com)",
      });
    }

    if (!(await authorizeProfile(userId, businessProfileId))) {
      return res.status(403).json({ error: "Business profile not found" });
    }

    const install = await prisma.widgetInstall.create({
      data: {
        userId,
        businessProfileId,
        publicSiteKey: newPublicSiteKey(),
        allowedOrigins: origins,
        label: label && typeof label === "string" ? label.slice(0, 200) : null,
      },
    });

    return res.status(201).json({
      success: true,
      install,
      embedNote:
        "Send X-Widget-Site-Key on every request (including CORS preflight). Conversation pageId convention: widget:{installId}.",
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
});

/** GET /v1/widget/installs */
widgetRoutes.get("/installs", async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id as number;
    const installs = await prisma.widgetInstall.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return res.json({ data: installs });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
});

/** DELETE /v1/widget/installs/:id/hard — remove row (cannot be undone) */
widgetRoutes.delete(
  "/installs/:id/hard",
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id as number;
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid id" });
      }

      const existing = await prisma.widgetInstall.findFirst({
        where: { id, userId },
      });
      if (!existing) {
        return res.status(404).json({ error: "Install not found" });
      }

      await prisma.widgetInstall.delete({ where: { id } });

      return res.json({ success: true });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return res.status(500).json({ error: msg });
    }
  },
);

/** PATCH /v1/widget/installs/:id */
widgetRoutes.patch("/installs/:id", async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id as number;
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const existing = await prisma.widgetInstall.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      return res.status(404).json({ error: "Install not found" });
    }

    const { allowedOrigins, label, isActive } = req.body as {
      allowedOrigins?: unknown;
      label?: string;
      isActive?: boolean;
    };

    const data: {
      allowedOrigins?: object;
      label?: string | null;
      isActive?: boolean;
    } = {};

    if (allowedOrigins !== undefined) {
      const origins = parseAllowedOrigins(allowedOrigins);
      if (origins.length === 0) {
        return res.status(400).json({
          error: "allowedOrigins must be a non-empty array when provided",
        });
      }
      data.allowedOrigins = origins;
    }
    if (label !== undefined) {
      data.label =
        typeof label === "string" ? label.slice(0, 200) : null;
    }
    if (isActive !== undefined) {
      data.isActive = Boolean(isActive);
    }

    const updated = await prisma.widgetInstall.update({
      where: { id },
      data,
    });

    return res.json({ success: true, install: updated });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
});

/** DELETE /v1/widget/installs/:id — soft-deactivate */
widgetRoutes.delete("/installs/:id", async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id as number;
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const existing = await prisma.widgetInstall.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      return res.status(404).json({ error: "Install not found" });
    }

    await prisma.widgetInstall.update({
      where: { id },
      data: { isActive: false },
    });

    return res.json({ success: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
});

/** GET /v1/widget/conversations — list web chats for user's businesses */
widgetRoutes.get("/conversations", async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id as number;
    const { page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    // Resolve all business profiles owned by this user
    const profiles = await prisma.businessProfile.findMany({
      where: { userId },
      select: { id: true },
    });
    const profileIds = profiles.map((p) => p.id);

    if (profileIds.length === 0) {
      return res.json({
        data: [],
        meta: { total: 0, page: Number(page), limit: Number(limit), totalPages: 0 },
      });
    }

    const [total, conversations] = await Promise.all([
      prisma.conversation.count({
        where: {
          businessProfileId: { in: profileIds },
          channel: "web",
        },
      }),
      prisma.conversation.findMany({
        where: {
          businessProfileId: { in: profileIds },
          channel: "web",
        },
        include: {
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
          },
        },
        orderBy: { updatedAt: "desc" },
        skip,
        take: Number(limit),
      }),
    ]);

    const data = conversations.map((c: any) => ({
      id: c.id,
      businessProfileId: c.businessProfileId,
      visitorId: c.senderId,
      installId: c.pageId.replace("widget:", ""),
      lastMessage: c.messages?.[0] || null,
      updatedAt: c.updatedAt,
      createdAt: c.createdAt,
    }));

    return res.json({
      data,
      meta: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
});

/** GET /v1/widget/conversations/:id/messages */
widgetRoutes.get("/conversations/:id/messages", async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id as number;
    const id = parseInt(req.params.id, 10);
    const { page = 1, limit = 50 } = req.query;

    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid conversation id" });
    }

    const conversation = await prisma.conversation.findFirst({
      where: {
        id,
        businessProfileId: {
          in: (await prisma.businessProfile.findMany({
            where: { userId },
            select: { id: true }
          })).map(p => p.id)
        },
        channel: "web"
      },
    });

    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const cursor = req.query.cursor ? parseInt(req.query.cursor as string, 10) : undefined;

    const messages = await listConversationMessages(
      id,
      Number(limit),
      cursor,
    );
    return res.json(messages);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
});

/** POST /v1/widget/conversations/:id/messages — reply to web chat */
widgetRoutes.post("/conversations/:id/messages", async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id as number;
    const id = parseInt(req.params.id, 10);
    const { text } = req.body as { text: string };

    if (isNaN(id)) {
      return res.status(400).json({ error: "Invalid conversation id" });
    }

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "text is required" });
    }

    const conversation = await prisma.conversation.findFirst({
      where: {
        id,
        businessProfileId: {
          in: (await prisma.businessProfile.findMany({
            where: { userId },
            select: { id: true }
          })).map(p => p.id)
        },
        channel: "web"
      },
    });

    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const saved = await saveMessage(id, "model", text.trim());
    
    // Notify Visitor (Web Widget) and Admin (Dashboard) about the admin reply
    emitToConversation(id, "new_message", { message: saved });
    emitToBusiness(conversation.businessProfileId, "new_message", {
      conversationId: id,
      message: saved
    });

    // Update conversation timestamp
    await prisma.conversation.update({
      where: { id },
      data: { updatedAt: new Date() }
    });

    return res.status(201).json({ data: saved });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ error: msg });
  }
});

/** PUT /v1/widget/conversations/:id/messages/:mid/approve — approve a draft */
widgetRoutes.put(
  "/conversations/:id/messages/:mid/approve",
  async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = (req as any).user.id as number;
      const conversationId = parseInt(req.params.id, 10);
      const messageId = parseInt(req.params.mid, 10);
      const { editedContent } = req.body as { editedContent?: string };

      if (isNaN(conversationId) || isNaN(messageId)) {
        return res.status(400).json({ error: "Invalid IDs" });
      }

      // Auth: ensure conversation belongs to a profile owned by user
      const conversation = await prisma.conversation.findFirst({
        where: {
          id: conversationId,
          businessProfile: { userId },
          channel: "web",
        },
      });

      if (!conversation) {
        return res
          .status(404)
          .json({ error: "Conversation not found or access denied." });
      }

      const message = await prisma.conversationMessage.findUnique({
        where: { id: messageId },
      });

      if (!message || message.conversationId !== conversationId) {
        return res.status(404).json({ error: "Message not found." });
      }

      const finalContent = editedContent || message.content;
      const isEdited = editedContent && editedContent !== message.content;

      // Update message transactionally
      const updatedMsg = await prisma.$transaction(async (tx) => {
        if (isEdited) {
          await tx.aiCorrection.create({
            data: {
              messageId: message.id,
              originalAiText: message.content,
              humanEditedText: finalContent,
            },
          });
        }

        // Re-open conversation if resolved
        if (conversation.status === "RESOLVED") {
          await tx.conversation.update({
            where: { id: conversationId },
            data: { status: "OPEN" },
          });
        }

        return await tx.conversationMessage.update({
          where: { id: messageId },
          data: {
            content: finalContent,
            status: isEdited ? "EDITED_AND_SENT" : "SENT",
          },
        });
      });

      // Notify sockets
      emitToBusiness(conversation.businessProfileId, "message_updated", {
        conversationId: conversation.id,
        message: updatedMsg,
      });
      emitToConversation(conversation.id, "new_message", {
        message: updatedMsg,
      });

      return res.status(200).json({ data: updatedMsg });
    } catch (e: any) {
      logger.error("widget.hitl.approve_error", { error: e.message });
      return res.status(500).json({ error: e.message });
    }
  }
);

/** DELETE /v1/widget/conversations/:id/messages/:mid — dismiss a draft */
widgetRoutes.delete(
  "/conversations/:id/messages/:mid",
  async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = (req as any).user.id as number;
      const conversationId = parseInt(req.params.id, 10);
      const messageId = parseInt(req.params.mid, 10);

      const conversation = await prisma.conversation.findFirst({
        where: { id: conversationId, businessProfile: { userId }, channel: "web" }
      });

      if (!conversation) return res.status(404).json({ error: "Not found" });

      const msg = await prisma.conversationMessage.findFirst({
        where: { id: messageId, conversationId, status: "PENDING_REVIEW" }
      });

      if (!msg) return res.status(404).json({ error: "Draft not found" });

      await prisma.conversationMessage.delete({ where: { id: messageId } });

      emitToBusiness(conversation.businessProfileId, "message_deleted", {
        conversationId,
        messageId
      });

      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  }
);

/** PATCH /v1/widget/conversations/:id/read — mark web chat as read */
widgetRoutes.patch(
  "/conversations/:id/read",
  async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = (req as any).user.id as number;
      const id = parseInt(req.params.id, 10);

      const conversation = await prisma.conversation.findFirst({
        where: { id, businessProfile: { userId }, channel: "web" }
      });

      if (!conversation) return res.status(404).json({ error: "Not found" });

      await prisma.conversation.update({
        where: { id },
        data: { updatedAt: new Date() }
      });

      return res.json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  }
);

/** POST /v1/widget/conversations/:id/suggest — trigger AI suggestion */
widgetRoutes.post(
  "/conversations/:id/suggest",
  async (req: Request, res: Response): Promise<any> => {
    try {
      const userId = (req as any).user.id as number;
      const conversationId = parseInt(req.params.id, 10);

      if (isNaN(conversationId)) {
        return res.status(400).json({ error: "Invalid IDs" });
      }

      // Auth
      const conversation = await prisma.conversation.findFirst({
        where: {
          id: conversationId,
          businessProfile: { userId },
          channel: "web",
        },
        include: { 
          businessProfile: {
            include: {
              externalDataSources: { where: { isActive: true } },
              crmIntegrations: { where: { isActive: true }, take: 1 },
            }
          } 
        },
      });

      if (!conversation) {
        return res
          .status(404)
          .json({ error: "Conversation not found or access denied." });
      }

      const historyRows = await getConversationHistory(conversationId);
      if (historyRows.length === 0) {
        return res
          .status(400)
          .json({ error: "No history found for suggesting." });
      }

      const lastUserMsg = historyRows[historyRows.length - 1];
      const historyForPrompt = toPromptMessages(historyRows);
      const historyTurns = historyToLlmTurns(historyForPrompt);

      const reply = await computeBusinessChatReply({
        businessProfile: conversation.businessProfile,
        messageText: lastUserMsg?.content || "",
        historyTurns,
        channel: "web",
      });

      const saved = await prisma.conversationMessage.create({
        data: {
          conversationId: conversation.id,
          role: "model",
          content: reply.content || "",
          status: "PENDING_REVIEW",
          aiReasoning: reply.reasoning,
          handoffCategory: reply.handoffCategory,
        },
      });

      // Notify
      emitToBusiness(conversation.businessProfileId, "new_message", {
        conversationId: conversation.id,
        message: saved,
      });
      emitToConversation(conversation.id, "new_message", {
        message: saved,
      });

      return res.status(201).json({ data: saved });
    } catch (e: any) {
      logger.error("widget.suggest_error", { error: e.message });
      return res.status(500).json({ error: e.message });
    }
  }
);

export default widgetRoutes;
