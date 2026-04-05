import { Router, Request, Response } from "express";
import { randomBytes } from "crypto";
import prisma from "../config/prisma";
import { authenticateToken } from "../middlewares/auth.middleware";
import { parseAllowedOrigins } from "../middlewares/widgetInstall.middleware";

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

export default widgetRoutes;
