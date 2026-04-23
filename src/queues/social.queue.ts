import { Queue } from "bullmq";
import { bullConnection } from "../config/redis";

/**
 * Enterprise-Grade Social Media Publishing Queue.
 * Handles scheduling, retries, and platform-specific logic.
 */
export const socialQueue = new Queue("social-publish", {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 1000 * 60 * 5, // 5 minutes backoff
    },
    removeOnComplete: true,
    removeOnFail: {
      age: 24 * 3600, // Keep failed jobs for 24h for audit
    },
  },
});

export interface SocialPublishJob {
  postId: number;
  platform: string;
  businessProfileId: number;
}
