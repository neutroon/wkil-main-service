import { Router, Request, Response } from "express";
import multer from "multer";
import { authenticateToken } from "@modules/auth/core/auth.middleware";
import {
  createMediaAsset,
  listMediaAssets,
  updateMediaAssetMeta,
  softDeleteAsset,
} from "@modules/media/services/mediaLibrary.service";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, R2_BUCKET } from "@modules/media/r2";
import {
  enqueueMediaSyncJob,
  enqueueMetaJob,
} from "@modules/meta/core/meta.queue";
import prisma from "@config/prisma";

import { validate } from "@middlewares/validate.middleware";
import {
  uploadMediaSchema,
  updateMediaSchema,
  aiGenerateSchema,
  aiRefineSchema,
  mediaIdParamSchema,
  mediaListQuerySchema,
} from "./media.validation";
import { AppError } from "@middlewares/errorHandler.middleware";

const router = Router();

// Use memory storage — we stream directly to R2, no local disk needed
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "video/mp4",
      "video/quicktime",
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

// ── GET /v1/media — List all active assets for authenticated user ─────────────
router.get(
  "/",
  authenticateToken,
  validate(mediaListQuerySchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id;
    const { businessProfileId, usageScope } = req.query as any;

    // Verify ownership
    const profile = await prisma.businessProfile.findFirst({
      where: { id: businessProfileId, userId },
    });
    if (!profile) throw new AppError("Access denied to business profile", 403);

    const assets = await listMediaAssets(businessProfileId, userId, usageScope);
    return res.json({ data: assets });
  },
);

// ── POST /v1/media — Upload a new media asset ─────────────────────────────────
router.post(
  "/",
  authenticateToken,
  upload.single("file"),
  validate(uploadMediaSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id;
    const { businessProfileId, name, instructions, usageScope } = req.body;

    if (!req.file) throw new AppError("No file uploaded", 400);

    const asset = await createMediaAsset({
      businessProfileId,
      userId,
      fileBuffer: req.file.buffer,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      name,
      instructions,
      usageScope,
    });

    return res
      .status(201)
      .json({
        data: asset,
        message: "Asset uploaded. Platform sync in progress.",
      });
  },
);

// ── PATCH /v1/media/:id — Update name or instructions only ────────────────────
router.patch(
  "/:id",
  authenticateToken,
  validate(updateMediaSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id;
    const { id: assetId } = req.params as any;
    const { name, instructions } = req.body;

    const updated = await updateMediaAssetMeta(assetId, userId, {
      name,
      instructions,
    });
    return res.json({ data: updated });
  },
);

// ── DELETE /v1/media/:id — Soft-delete ───────────────────────────────────────
router.delete(
  "/:id",
  authenticateToken,
  validate(mediaIdParamSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id;
    const { id } = req.params as any;
    await softDeleteAsset(id, userId);
    return res.json({ message: "Asset deactivated successfully" });
  },
);

// ── GET /v1/media/:id/sync-status — Poll platform sync status ────────────────
router.get(
  "/:id/sync-status",
  authenticateToken,
  validate(mediaIdParamSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id;
    const { id } = req.params as any;
    const asset = await prisma.businessProfileMedia.findFirst({
      where: { id, userId },
      include: {
        syncs: {
          orderBy: { updatedAt: "desc" },
        },
      },
    });

    if (!asset) throw new AppError("Asset not found", 404);
    return res.json({ data: asset });
  },
);

// ── GET /v1/media/file/* — Fallback proxy to serve R2 files if no CDN URL is set ──
router.get(/\/file\/(.+)/, async (req: Request, res: Response) => {
  const key = req.params[0];
  if (!key) throw new AppError("Key is required", 400);

  const getObj = await r2Client.send(
    new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
    }),
  );

  const contentType = getObj.ContentType || "application/octet-stream";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("Access-Control-Allow-Origin", "*"); // Allow frontend to fetch/preview

  if (getObj.Body) {
    (getObj.Body as any).pipe(res);
  } else {
    throw new AppError("File body is empty", 404);
  }
});

// ── POST /v1/media/:id/retry — Re-enqueue manual sync ────────────────────────
router.post(
  "/:id/retry",
  authenticateToken,
  validate(mediaIdParamSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id;
    const { id: assetId } = req.params as any;

    const asset = await prisma.businessProfileMedia.findFirst({
      where: { id: assetId, userId },
    });

    if (!asset) throw new AppError("Asset not found", 404);

    await enqueueMediaSyncJob(assetId);

    return res.json({ success: true, message: "Sync job re-queued" });
  },
);

/**
 * ── POST /v1/media/ai/generate ──────────────────────────────────────────────
 * Unified End-to-End Gemini 3.1 Visual Generation
 */
router.post(
  "/ai/generate",
  authenticateToken,
  validate(aiGenerateSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id;
    const { businessProfileId, prompt, postId } = req.body;

    // 1. Resilience: Set status to 'generating' immediately
    if (postId) {
      await prisma.contentPlanPost.update({
        where: { id: postId },
        data: { status: "generating" },
      });
    }

    // 2. Enqueue the background worker job
    await enqueueMetaJob({
      platform: "visual_production",
      type: "visual_production",
      identifier: String(businessProfileId),
      senderId: String(userId),
      messageText: prompt,
      businessProfileId,
      postId,
    } as any);

    return res.status(202).json({
      message: "Generation task accepted and moved to background worker.",
      status: "processing",
    });
  },
);

/**
 * ── POST /v1/media/ai/refine ────────────────────────────────────────────────
 * Conversational Image Editing via Gemini 3.1 (Nano Banana 2)
 */
router.post(
  "/ai/refine",
  authenticateToken,
  validate(aiRefineSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id;
    const { businessProfileId, assetId, instruction, postId } = req.body;

    // 1. Resilience: Set status to 'generating' immediately
    if (postId) {
      await prisma.contentPlanPost.update({
        where: { id: postId },
        data: { status: "generating" },
      });
    }

    // 2. Enqueue the background worker job
    await enqueueMetaJob({
      platform: "visual_refine",
      type: "visual_refine",
      identifier: String(businessProfileId),
      senderId: String(userId),
      messageText: instruction,
      mediaId: String(assetId),
      businessProfileId,
      postId,
    } as any);

    return res.status(202).json({
      message: "Refinement task accepted and moved to background worker.",
      status: "processing",
    });
  },
);

export default router;
