import { Router, Request, Response } from "express";
import multer from "multer";
import { authenticateToken } from "../middlewares/auth.middleware";
import {
  createMediaAsset,
  listMediaAssets,
  updateMediaAssetMeta,
  softDeleteAsset,
} from "../services/media/mediaLibrary.service";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, R2_BUCKET } from "../config/r2";
import { enqueueMediaSyncJob } from "../queues/meta.queue";
import prisma from "../config/prisma";
import { logger } from "../utils/logger";

const router = Router();

// Use memory storage — we stream directly to R2, no local disk needed
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg", "image/png", "image/gif", "image/webp",
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "video/mp4", "video/quicktime",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

// ── GET /v1/media — List all active assets for authenticated user ─────────────
router.get("/", authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const businessProfileId = Number(req.query.businessProfileId);

    if (!businessProfileId) {
      return res.status(400).json({ error: "businessProfileId is required" });
    }

    // Verify ownership
    const profile = await prisma.businessProfile.findFirst({
      where: { id: businessProfileId, userId },
    });
    if (!profile) return res.status(403).json({ error: "Access denied" });

    const assets = await listMediaAssets(businessProfileId, userId);
    return res.json({ data: assets });
  } catch (err: any) {
    logger.error("media.routes.list_failed", { error: err.message });
    return res.status(500).json({ error: "Failed to list media assets" });
  }
});

// ── POST /v1/media — Upload a new media asset ─────────────────────────────────
router.post(
  "/",
  authenticateToken,
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).user.id;
      const { businessProfileId, name, instructions } = req.body;

      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      if (!businessProfileId || !name || !instructions) {
        return res.status(400).json({ error: "businessProfileId, name, and instructions are required" });
      }
      if (name.trim().length < 2) return res.status(400).json({ error: "Name must be at least 2 characters" });
      if (instructions.trim().length < 10) return res.status(400).json({ error: "Instructions must be at least 10 characters" });

      const asset = await createMediaAsset({
        businessProfileId: Number(businessProfileId),
        userId,
        fileBuffer: req.file.buffer,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        name,
        instructions,
      });

      return res.status(201).json({ data: asset, message: "Asset uploaded. Platform sync in progress." });
    } catch (err: any) {
      logger.error("media.routes.upload_failed", { error: err.message });
      if (err.message.includes("access denied") || err.message.includes("not found")) {
        return res.status(403).json({ error: err.message });
      }
      if (err.message.includes("Unsupported") || err.message.includes("exceeds")) {
        return res.status(422).json({ error: err.message });
      }
      return res.status(500).json({ error: "Upload failed" });
    }
  },
);

// ── PATCH /v1/media/:id — Update name or instructions only ────────────────────
router.patch("/:id", authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const assetId = Number(req.params.id);
    const { name, instructions } = req.body;

    if (!name && !instructions) {
      return res.status(400).json({ error: "Provide name or instructions to update" });
    }

    const updated = await updateMediaAssetMeta(assetId, userId, { name, instructions });
    return res.json({ data: updated });
  } catch (err: any) {
    logger.error("media.routes.update_failed", { error: err.message });
    return res.status(err.message.includes("denied") ? 403 : 500).json({ error: err.message });
  }
});

// ── DELETE /v1/media/:id — Soft-delete ───────────────────────────────────────
router.delete("/:id", authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    await softDeleteAsset(Number(req.params.id), userId);
    return res.json({ message: "Asset deactivated successfully" });
  } catch (err: any) {
    logger.error("media.routes.delete_failed", { error: err.message });
    return res.status(err.message.includes("denied") ? 403 : 500).json({ error: err.message });
  }
});

// ── GET /v1/media/:id/sync-status — Poll platform sync status ────────────────
router.get("/:id/sync-status", authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const asset = await prisma.businessProfileMedia.findFirst({
      where: { id: Number(req.params.id), userId },
      include: {
        syncs: {
          orderBy: { updatedAt: "desc" },
        },
      },
    });

    if (!asset) return res.status(404).json({ error: "Asset not found" });
    return res.json({ data: asset });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /v1/media/file/* — Fallback proxy to serve R2 files if no CDN URL is set ──
router.get("/file/(.*)", async (req: Request, res: Response) => {
  try {
    const key = req.params[0];
    if (!key) return res.status(400).json({ error: "Key is required" });

    const getObj = await r2Client.send(
      new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
      })
    );

    const contentType = getObj.ContentType || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Access-Control-Allow-Origin", "*"); // Allow frontend to fetch/preview

    if (getObj.Body) {
      (getObj.Body as any).pipe(res);
    } else {
      res.status(404).json({ error: "File body is empty" });
    }
  } catch (err: any) {
    logger.warn("media.proxy.failed", { key: req.params[0], error: err.message });
    res.status(404).json({ error: "File not found in storage" });
  }
});

// ── POST /v1/media/:id/retry — Re-enqueue manual sync ────────────────────────
router.post("/:id/retry", authenticateToken, async (req: Request, res: Response) => {
  // ... (existing logic)
});

/**
 * ── POST /v1/media/ai/generate ──────────────────────────────────────────────
 * Unified End-to-End Gemini 3.1 Visual Generation
 */
router.post("/ai/generate", authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const { businessProfileId, prompt, postId } = req.body;

    if (!businessProfileId || !prompt) {
      return res.status(400).json({ error: "businessProfileId and prompt are required" });
    }

    const { createGeminiVisual } = await import("../services/media/geminiVisual.service");
    const asset = await createGeminiVisual({
      userId,
      businessProfileId: Number(businessProfileId),
      userPrompt: prompt,
      postId: postId ? Number(postId) : undefined,
    });

    return res.status(201).json({ 
      data: asset, 
      message: "Studio asset generated successfully. Meta sync pending." 
    });
  } catch (err: any) {
    logger.error("media.gemini.generate_failed", { error: err.message });
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.message });
  }
});

/**
 * ── POST /v1/media/ai/refine ────────────────────────────────────────────────
 * Conversational Image Editing via Gemini 3.1 (Nano Banana 2)
 */
router.post("/ai/refine", authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const { businessProfileId, assetId, instruction, postId } = req.body;

    if (!businessProfileId || !assetId || !instruction) {
      return res.status(400).json({ error: "businessProfileId, assetId, and instruction are required" });
    }

    const { refineGeminiVisual } = await import("../services/media/geminiVisual.service");
    const asset = await refineGeminiVisual({
      userId,
      businessProfileId: Number(businessProfileId),
      assetId: Number(assetId),
      instruction,
      postId: postId ? Number(postId) : undefined,
    });

    return res.status(200).json({ 
      data: asset, 
      message: "Asset refined successfully via Nano Banana reasoning." 
    });
  } catch (err: any) {
    logger.error("media.gemini.refine_failed", { error: err.message });
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.message });
  }
});

export default router;
