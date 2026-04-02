import { Router } from "express";
import { Request, Response } from "express";
import { generatePostContent } from "../services/content.service";
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
