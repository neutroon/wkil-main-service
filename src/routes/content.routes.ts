import { Router } from "express";
import { Request, Response } from "express";
import { generatePostContent } from "../services/content.service";
import { generateContentStrategy, generatePostExecution } from "../services/contentPlan.service";
import { authenticateToken } from "../middlewares/auth.middleware";
import { validateContentGeneration } from "../middlewares/validation.middleware";
import { contentLimiter } from "../middlewares/rateLimit.middleware";
import prisma from "../config/prisma";
import upload from "../config/upload";

const contentRoutes = Router();

// Generate post content (protected route with validation and rate limiting)
contentRoutes.post(
  "/generate-post",
  contentLimiter,
  authenticateToken,
  validateContentGeneration,
  async (req: Request, res: Response) => {
    const startTime = Date.now();

    try {
      const {
        topic,
        businessProfileId,
        length = "medium",
        keywords = [],
        context = "",
        generateImage = false,
      } = req.body;
      const userId = (req as any).user.id as number;

      let businessProfile = null;
      if (businessProfileId) {
        businessProfile = await prisma.businessProfile.findFirst({
          where: { id: parseInt(String(businessProfileId), 10), userId },
          select: { name: true, identity: true, targetAudience: true, voice: true, tone: true },
        });
      } else {
        // Fallback to the first profile owned by the user
        businessProfile = await prisma.businessProfile.findFirst({
          where: { userId },
          select: { name: true, identity: true, targetAudience: true, voice: true, tone: true },
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

      const endTime = Date.now();
      console.log(
        `[ContentAPI] Post generated successfully in ${
          endTime - startTime
        }ms | Image: ${generateImage ? "Yes" : "No"}`
      );

      res.json(result);
    } catch (err: any) {
      const endTime = Date.now();
      console.error(
        `[ContentAPI] Post generation failed in ${endTime - startTime}ms:`,
        err.message
      );

      // Handle specific error types
      if (
        err.message.includes("API key") ||
        err.message.includes("authentication")
      ) {
        res.status(401).json({
          error: "Google Cloud authentication failed",
          details:
            "Verify your service account key is valid and has proper permissions",
          code: "AUTH_ERROR",
        });
      } else if (
        err.message.includes("quota") ||
        err.message.includes("rate limit")
      ) {
        res.status(429).json({
          error: "Google Cloud quota exceeded",
          details:
            "Check your billing and usage limits at console.cloud.google.com",
          code: "QUOTA_EXCEEDED",
        });
      } else if (
        err.message.includes("network") ||
        err.message.includes("timeout")
      ) {
        res.status(503).json({
          error: "Google Cloud services temporarily unavailable",
          details: "Please try again later or check Google Cloud status",
          code: "SERVICE_UNAVAILABLE",
        });
      } else if (err.message.includes("Missing Google Cloud configuration")) {
        res.status(500).json({
          error: "Server configuration error",
          details: "Missing required Google Cloud environment variables",
          code: "CONFIG_ERROR",
        });
      } else {
        res.status(500).json({
          error: err.message || "Failed to generate post content",
          details: "An unexpected error occurred during content generation",
          code: "GENERATION_ERROR",
        });
      }
    }
  }
);

// Generate Content Strategy Plan (Phase 1)
contentRoutes.post(
  "/plan/generate-strategy",
  contentLimiter,
  authenticateToken,
  async (req: any, res: Response) => {
    try {
      const { businessProfileId, startDate, endDate, goals, currentTrends } = req.body;
      const userId = req.user.id;
      
      if (!startDate || !endDate) {
        return res.status(400).json({ error: "startDate and endDate are required" });
      }

      let targetProfileId = parseInt(businessProfileId, 10);
      if (!targetProfileId || isNaN(targetProfileId)) {
        const defaultProfile = await prisma.businessProfile.findFirst({
          where: { userId }
        });
        if (!defaultProfile) {
          return res.status(400).json({ error: "No business profile found. Please create one first." });
        }
        targetProfileId = defaultProfile.id;
      }

      const plan = await generateContentStrategy({
        businessProfileId: targetProfileId,
        userId,
        startDate,
        endDate,
        goals,
        currentTrends
      });

      res.json(plan);
    } catch (err: any) {
      console.error("[ContentAPI] Strategy generation failed:", err.message);
      res.status(500).json({ error: err.message || "Failed to generate strategy" });
    }
  }
);

// Generate Content Execution (Phase 2)
contentRoutes.post(
  "/plan/:planId/generate-post/:postId",
  contentLimiter,
  authenticateToken,
  async (req: any, res: Response) => {
    try {
      const { postId } = req.params;
      const userId = req.user.id;

      const updatedPost = await generatePostExecution(parseInt(postId, 10), userId);
      res.json(updatedPost);
    } catch (err: any) {
      console.error("[ContentAPI] Post execution failed:", err.message);
      res.status(500).json({ error: err.message || "Failed to execute post content" });
    }
  }
);

// Approve Post
contentRoutes.patch(
  "/plan/posts/:postId/approve",
  authenticateToken,
  async (req: any, res: Response) => {
    try {
      const { postId } = req.params;
      const { manual } = req.body; // true if approved but manual posting
      
      const userId = req.user.id;
      const post = await prisma.contentPlanPost.findUnique({
        where: { id: parseInt(postId, 10) },
        include: { contentPlan: true }
      });
      
      if (!post || post.contentPlan.userId !== userId) {
        return res.status(403).json({ error: "Unauthorized or post not found" });
      }

      const updated = await prisma.contentPlanPost.update({
        where: { id: parseInt(postId, 10) },
        data: { status: manual ? "approved_manual" : "approved" }
      });

      res.json(updated);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to approve post" });
    }
  }
);

// Fetch Content Plans
contentRoutes.get(
  "/plan/list/active",
  authenticateToken,
  async (req: any, res: Response) => {
    try {
      const userId = req.user.id;

      // Find first profile as fallback
      const defaultProfile = await prisma.businessProfile.findFirst({
        where: { userId }
      });

      if (!defaultProfile) {
         return res.json([]);
      }

      const plans = await prisma.contentPlan.findMany({
        where: { 
          businessProfileId: defaultProfile.id,
          userId 
        },
        include: { posts: { orderBy: { scheduledAt: 'asc' } } },
        orderBy: { createdAt: 'desc' }
      });

      res.json(plans);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Failed to fetch plans" });
    }
  }
);

// Upload image (protected route)
contentRoutes.post(
  "/upload-image",
  authenticateToken,
  upload.single("image"),
  (req: any, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No image file provided" });
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
      } = req.file;

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
    } catch (err: any) {
      console.error("Image upload error:", err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

export default contentRoutes;
