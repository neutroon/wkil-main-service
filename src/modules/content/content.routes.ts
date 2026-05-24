import { Router, Request, Response } from "express";
import { generatePostContent } from "./content.service";
import { generatePostExecution } from "./contentPlan.service";
import {
  generateContentAuditStream,
  getContentBrief,
  saveContentBrief,
} from "./contentBrief.service";
import { authenticateToken } from "@modules/auth/core/auth.middleware";
import { contentLimiter } from "@middlewares/rateLimit.middleware";
import prisma from "@config/prisma";
import upload from "@modules/media/upload.config";
import { validate } from "@middlewares/validate.middleware";
import {
  generatePostSchema,
  generateStrategySchema,
  contentAuditSchema,
  saveContentBriefSchema,
  contentBriefIdParamSchema,
  approvePostSchema,
  contentIdParamSchema,
  planPostIdParamSchema,
} from "./content.validation";
import { AppError } from "@middlewares/errorHandler.middleware";

const contentRoutes = Router();

// Generate signal-led content audit and draft brief
contentRoutes.post(
  "/brief/audit",
  contentLimiter,
  authenticateToken,
  validate(contentAuditSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const body = req.body;

    let targetProfileId = parseInt(String(body.businessProfileId), 10);
    if (!targetProfileId || isNaN(targetProfileId)) {
      const defaultProfile = await prisma.businessProfile.findFirst({
        where: { userId },
      });
      if (!defaultProfile) {
        throw new AppError(
          "No business profile found. Please create one first.",
          404,
        );
      }
      targetProfileId = defaultProfile.id;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const generator = generateContentAuditStream({
      ...body,
      businessProfileId: targetProfileId,
      userId,
    });

    try {
      for await (const update of generator) {
        res.write(`data: ${JSON.stringify(update)}\n\n`);
      }
      res.end();
    } catch (err: any) {
      res.write(
        `data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`,
      );
      res.end();
    }
  },
);

// Save or confirm a content brief
contentRoutes.post(
  "/brief",
  authenticateToken,
  validate(saveContentBriefSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const brief = await saveContentBrief(userId, req.body);
    res.status(201).json(brief);
  },
);

// Fetch a confirmed content brief
contentRoutes.get(
  "/brief/:id",
  authenticateToken,
  validate(contentBriefIdParamSchema),
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id as number;
    const brief = await getContentBrief(userId, Number(req.params.id));
    res.json(brief);
  },
);

// Generate post content (protected route with validation and rate limiting)
contentRoutes.post(
  "/generate-post",
  contentLimiter,
  authenticateToken,
  validate(generatePostSchema),
  async (req: Request, res: Response) => {
    const {
      topic,
      businessProfileId,
      length,
      keywords,
      context,
      generateImage,
    } = req.body;
    const userId = (req as any).user.id as number;

    let businessProfile = null;
    if (businessProfileId) {
      businessProfile = await prisma.businessProfile.findFirst({
        where: { id: parseInt(String(businessProfileId), 10), userId },
        select: {
          name: true,
          identity: true,
          targetAudience: true,
          voice: true,
          tone: true,
          productsServices: true,
          corePolicies: true,
          aiBehaviorInstructions: true,
        },
      });
    } else {
      businessProfile = await prisma.businessProfile.findFirst({
        where: { userId },
        select: {
          name: true,
          identity: true,
          targetAudience: true,
          voice: true,
          tone: true,
          productsServices: true,
          corePolicies: true,
          aiBehaviorInstructions: true,
        },
      });
    }

    const result = await generatePostContent({
      topic,
      length,
      keywords,
      context,
      generateImage,
      businessProfile,
    });

    res.json(result);
  },
);

// Generate Content Strategy Plan (Phase 1)
contentRoutes.post(
  "/plan/generate-strategy",
  contentLimiter,
  authenticateToken,
  validate(generateStrategySchema),
  async (req: Request, res: Response) => {
    const { businessProfileId, contentBriefId, startDate, endDate, goals, currentTrends } =
      req.body;
    const userId = (req as any).user.id;

    // Set headers for SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    let targetProfileId = parseInt(String(businessProfileId), 10);
    if (!targetProfileId || isNaN(targetProfileId)) {
      const defaultProfile = await prisma.businessProfile.findFirst({
        where: { userId },
      });
      if (!defaultProfile) {
        throw new AppError(
          "No business profile found. Please create one first.",
          404,
        );
      }
      targetProfileId = defaultProfile.id;
    }

    const generator = (
      await import("./contentPlan.service")
    ).generateContentStrategyStream({
      businessProfileId: targetProfileId,
      userId,
      contentBriefId,
      startDate,
      endDate,
      goals,
      currentTrends,
    });

    try {
      for await (const update of generator) {
        res.write(`data: ${JSON.stringify(update)}\n\n`);
      }
      res.end();
    } catch (err: any) {
      res.write(
        `data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`,
      );
      res.end();
    }
  },
);

// Generate Content Execution (Phase 2)
contentRoutes.post(
  "/plan/:planId/generate-post/:postId",
  contentLimiter,
  authenticateToken,
  validate(planPostIdParamSchema),
  async (req: Request, res: Response) => {
    const { postId } = req.params;
    const userId = (req as any).user.id;

    const updatedPost = await generatePostExecution(
      parseInt(postId, 10),
      userId,
    );
    res.json(updatedPost);
  },
);

// Approve Post
contentRoutes.patch(
  "/plan/posts/:postId/approve",
  authenticateToken,
  validate(approvePostSchema),
  async (req: Request, res: Response) => {
    const { postId } = req.params;
    const { manual } = req.body;
    const userId = (req as any).user.id;

    const post = await prisma.contentPlanPost.findUnique({
      where: { id: parseInt(postId, 10) },
      include: { contentPlan: true },
    });

    if (!post || post.contentPlan.userId !== userId) {
      throw new AppError("Unauthorized or post not found", 403);
    }

    const updated = await prisma.contentPlanPost.update({
      where: { id: parseInt(postId, 10) },
      data: { status: manual ? "approved_manual" : "approved" },
      include: { contentPlan: true },
    });

    if (!manual && updated.scheduledAt) {
      const { socialQueue } = await import("../content/social.queue");
      const delay = Math.max(
        0,
        new Date(updated.scheduledAt).getTime() - Date.now(),
      );

      await socialQueue.add(
        `publish-${updated.id}`,
        {
          postId: updated.id,
          platform: updated.platform,
          businessProfileId: updated.contentPlan.businessProfileId,
        },
        { delay, jobId: `post-${updated.id}` },
      );
    }

    res.json(updated);
  },
);

// Fetch Content Plans
contentRoutes.get(
  "/plan/list/active",
  authenticateToken,
  async (req: Request, res: Response) => {
    const userId = (req as any).user.id;
    const { businessProfileId, limit = 10, offset = 0 } = req.query;

    const where: any = { userId };
    if (businessProfileId) {
      where.businessProfileId = parseInt(String(businessProfileId), 10);
    }

    const take = parseInt(String(limit), 10);
    const skip = parseInt(String(offset), 10);

    const [plans, total] = await Promise.all([
      prisma.contentPlan.findMany({
        where,
        include: {
          posts: { orderBy: { scheduledAt: "asc" } },
          businessProfile: { select: { name: true } },
          contentBrief: { select: { id: true, goal: true, funnelFocus: true } },
        },
        orderBy: { createdAt: "desc" },
        take,
        skip,
      }),
      prisma.contentPlan.count({ where }),
    ]);

    res.json({
      plans,
      total,
      hasMore: skip + take < total,
    });
  },
);

// Fetch Single Content Plan
contentRoutes.get(
  "/plan/:id",
  authenticateToken,
  validate(contentIdParamSchema),
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const userId = (req as any).user.id;

    const plan = await prisma.contentPlan.findUnique({
      where: { id: parseInt(id, 10), userId },
      include: {
        posts: { orderBy: { scheduledAt: "asc" } },
        contentBrief: true,
        businessProfile: {
          select: {
            id: true,
            name: true,
            identity: true,
            targetAudience: true,
            voice: true,
            tone: true,
          },
        },
      },
    });

    if (!plan) {
      throw new AppError("Content plan not found", 404);
    }

    res.json(plan);
  },
);

// Upload image (protected route)
contentRoutes.post(
  "/upload-image",
  authenticateToken,
  upload.single("image"),
  (req: Request, res: Response) => {
    if (!req.file) {
      throw new AppError("No image file provided", 400);
    }

    const {
      path,
      filename,
      secure_url,
      public_id,
      format,
      width,
      height,
      bytes,
    } = req.file as any;

    const imageUrl = path || secure_url;
    const publicId = filename || public_id;

    res.json({
      imageUrl,
      publicId,
      format,
      width,
      height,
      size: bytes,
    });
  },
);

export default contentRoutes;









