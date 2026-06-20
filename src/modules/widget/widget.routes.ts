import { Router, Request, Response } from "express";
import { randomBytes } from "crypto";
import prisma from "@config/prisma";
import { authenticateToken } from "@modules/auth/core/auth.middleware";
import { parseAllowedOrigins } from "@modules/widget/widgetInstall.middleware";
import {
  listConversationMessages,
  saveMessage,
} from "@modules/meta/core/conversation.service";

import { validate } from "@middlewares/validate.middleware";
import { 
  widgetInstallSchema, 
  updateWidgetInstallSchema, 
  widgetConversationQuerySchema,
  widgetReplySchema,
  widgetIdParamSchema
} from "./widgetAuth.validation";
import { AppError } from "@middlewares/errorHandler.middleware";
import { generateIdentitySecret } from "./services/widgetIdentity.service";

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
widgetRoutes.post(
  "/installs", 
  validate(widgetInstallSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const { businessProfileId, allowedOrigins, label } = req.body;

    const origins = parseAllowedOrigins(allowedOrigins);
    if (origins.length === 0) {
      throw new AppError("allowedOrigins must be a non-empty array of origin strings", 400);
    }

    if (!(await authorizeProfile(userId, businessProfileId))) {
      throw new AppError("Business profile not found", 403);
    }

    const install = await prisma.widgetInstall.create({
      data: {
        userId,
        businessProfileId,
        publicSiteKey: newPublicSiteKey(),
        identitySecret: generateIdentitySecret(),
        allowedOrigins: origins,
        label: label || null,
      },
    });

    return res.status(201).json({
      success: true,
      install,
      embedNote:
        "Send X-Widget-Site-Key on every request (including CORS preflight). Conversation pageId convention: widget:{installId}.",
    });
  }
);

/** GET /v1/widget/installs */
widgetRoutes.get("/installs", async (req: Request, res: Response) => {
  const userId = (req as any).user.id as number;
  const installs = await prisma.widgetInstall.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  return res.json({ data: installs });
});

/** GET /v1/widget/installs/:id/identity-secret — per-install HMAC secret for identity verification */
widgetRoutes.get(
  "/installs/:id/identity-secret",
  validate(widgetIdParamSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const id = parseInt(req.params.id, 10);

    const install = await prisma.widgetInstall.findFirst({
      where: { id, userId },
      select: { identitySecret: true },
    });
    if (!install) {
      throw new AppError("Install not found", 404);
    }

    return res.json({ enabled: true, identitySecret: install.identitySecret });
  },
);

/** DELETE /v1/widget/installs/:id/hard — remove row (cannot be undone) */
widgetRoutes.delete(
  "/installs/:id/hard",
  validate(widgetIdParamSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const id = parseInt(req.params.id, 10);

    const existing = await prisma.widgetInstall.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      throw new AppError("Install not found", 404);
    }

    await prisma.widgetInstall.delete({ where: { id } });

    return res.json({ success: true });
  }
);

/** PATCH /v1/widget/installs/:id */
widgetRoutes.patch(
  "/installs/:id", 
  validate(updateWidgetInstallSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const id = parseInt(req.params.id, 10);

    const existing = await prisma.widgetInstall.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      throw new AppError("Install not found", 404);
    }

    const { businessProfileId, allowedOrigins, label, isActive } = req.body;
    const data: any = {};

    if (businessProfileId !== undefined) {
      if (!(await authorizeProfile(userId, businessProfileId))) {
        throw new AppError("Business profile not found", 403);
      }
      data.businessProfileId = businessProfileId;
    }
    if (allowedOrigins !== undefined) {
      const origins = parseAllowedOrigins(allowedOrigins);
      if (origins.length === 0) {
        throw new AppError("allowedOrigins must be a non-empty array when provided", 400);
      }
      data.allowedOrigins = origins;
    }
    if (label !== undefined) {
      data.label = label || null;
    }
    if (isActive !== undefined) {
      data.isActive = Boolean(isActive);
    }

    const updated = await prisma.widgetInstall.update({
      where: { id },
      data,
    });

    return res.json({ success: true, install: updated });
  }
);

/** DELETE /v1/widget/installs/:id — soft-deactivate */
widgetRoutes.delete(
  "/installs/:id", 
  validate(widgetIdParamSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const id = parseInt(req.params.id, 10);

    const existing = await prisma.widgetInstall.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      throw new AppError("Install not found", 404);
    }

    await prisma.widgetInstall.update({
      where: { id },
      data: { isActive: false },
    });

    return res.json({ success: true });
  }
);

/** GET /v1/widget/conversations — list web chats for user's businesses */
widgetRoutes.get(
  "/conversations", 
  validate(widgetConversationQuerySchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const { page, limit, status } = req.query as any;
    const skip = (Number(page) - 1) * Number(limit);
    const statusFilter = status === "ARCHIVED" ? "ARCHIVED" : { not: "ARCHIVED" };

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
          status: statusFilter,
        },
      }),
      prisma.conversation.findMany({
        where: {
          businessProfileId: { in: profileIds },
          channel: "web",
          status: statusFilter,
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
      customerId: c.customerId,
      businessProfileId: c.businessProfileId,
      visitorId: c.senderId,
      installId: c.pageId.replace("widget:", ""),
      customerName: c.customerName,
      customerPhone: c.customerPhone,
      customerAvatar: c.customerAvatar,
      lastMessage: c.messages?.[0] || null,
      aiEnabled: c.aiEnabled,
      readAt: c.readAt,
      status: c.status,
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
  }
);

/** GET /v1/widget/conversations/:id/messages */
widgetRoutes.get(
  "/conversations/:id/messages", 
  validate(widgetIdParamSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const id = parseInt(req.params.id, 10);
    const { limit = 50 } = req.query;

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
      throw new AppError("Conversation not found", 404);
    }

    const cursor = req.query.cursor ? parseInt(req.query.cursor as string, 10) : undefined;

    const messages = await listConversationMessages(
      id,
      Number(limit),
      cursor,
    );
    return res.json(messages);
  }
);

/** POST /v1/widget/conversations/:id/messages — reply to web chat */
widgetRoutes.post(
  "/conversations/:id/messages", 
  validate(widgetReplySchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const id = parseInt(req.params.id, 10);
    const { text } = req.body;

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
      throw new AppError("Conversation not found", 404);
    }

    const saved = await saveMessage(id, "agent", text.trim(), {
      status: "SENT",
    });

    return res.status(201).json({ data: saved });
  }
);

/** PATCH /v1/widget/conversations/:id/read — mark web chat as read */
widgetRoutes.patch(
  "/conversations/:id/read",
  async (req: Request, res: Response): Promise<any> => {
    const userId = (req as any).user.id as number;
    const id = parseInt(req.params.id, 10);

    const conversation = await prisma.conversation.findFirst({
      where: { id, businessProfile: { userId }, channel: "web" }
    });

    if (!conversation) throw new AppError("Not found", 404);

    await prisma.conversation.update({
      where: { id },
      data: { updatedAt: new Date() }
    });

    return res.json({ success: true });
  }
);

export default widgetRoutes;








