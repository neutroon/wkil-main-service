import * as Sentry from "@sentry/node";
import { Worker, Job } from "bullmq";
import { bullConnection } from "@config/redis";
import prisma from "@config/prisma";
import { createPost } from "../meta/facebook/facebook.service";
import { logger } from "@utils/logger";
import { SocialPublishJob } from "./social.queue";
import { AppError } from "@middlewares/errorHandler.middleware";

/**
 * Enterprise-Grade Social Media Worker.
 * Processes delayed publishing jobs with high precision.
 */
export const socialWorker = new Worker(
  "social-publish",
  async (job: Job<SocialPublishJob>) => {
    const { postId, platform, businessProfileId } = job.data;

    logger.info("social_worker.job_started", { postId, platform, jobId: job.id });

    try {
      // 1. Fetch Fresh Post Data (Just-in-Time)
      const post = await prisma.contentPlanPost.findUnique({
        where: { id: postId },
        include: { 
          mediaAsset: true, // Include user-uploaded assets
          contentPlan: { 
            include: { businessProfile: true } 
          } 
        }
      });

      if (!post) {
        logger.error("social_worker.post_not_found", { postId });
        return;
      }

      // Check if user changed their mind (cancelled)
      if (post.status !== "approved") {
        logger.warn("social_worker.post_skipped", { postId, currentStatus: post.status });
        return;
      }

      // 2. Resolve Content & Assets (Just-in-Time)
      const message = post.caption || "";
      // Priority: User Uploaded Asset > AI Generated Image
      const finalImageUrl = post.mediaAsset?.publicUrl || post.imageUrl; 

      // 3. Platform Specific Execution
      if (platform === "facebook") {
        const page = await prisma.facebookPage.findFirst({
          where: { businessProfileId, isActive: true }
        });

        if (!page) throw new AppError("No active Facebook page connected for this business.", 404);

        const result = await createPost({
          pageId: page.pageId,
          message,
          imageUrl: finalImageUrl || undefined,
          accessToken: undefined, // Let the service decrypt from DB
        });

        logger.info("social_worker.facebook_published", { postId, fbPostId: result.id });
      } else {
        throw new AppError(`Platform ${platform} not supported yet.`, 400);
      }

      // 4. Mark as Published
      await prisma.contentPlanPost.update({
        where: { id: postId },
        data: { 
          status: "published",
          postedAt: new Date()
        }
      });

    } catch (err: any) {
      logger.error("social_worker.job_failed", { postId, error: err.message });
      throw err; // Trigger BullMQ retry with backoff
    }
  },
  { 
    connection: bullConnection,
    concurrency: 5 // Allow 5 parallel publishing operations
  }
);

socialWorker.on("completed", (job) => {
  logger.info("social_worker.job_completed", { jobId: job.id });
});

socialWorker.on("failed", (job, err) => {
  logger.error("social_worker.job_failed_permanently", { jobId: job?.id, error: err.message });
  Sentry.captureException(err, {
    extra: {
      jobId: job?.id,
      jobName: job?.name,
      data: job?.data,
    },
  });
});





