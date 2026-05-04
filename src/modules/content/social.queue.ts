import { Queue } from "bullmq";
import { bullConnection } from "@config/redis";

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
    // removeOnComplete: {
    //   count: 1000,
    //   age: 7 * 24 * 3600, // Keep last 1000 or 7 days for social publishing audit
    // },
    removeOnComplete: {
      count: 10, // Keep last 1000 or 7 days for social publishing audit
    },
    removeOnFail: {
      count: 50, // Keep failed social posts for manual review/retry
    },
  },
});

export interface SocialPublishJob {
  postId: number;
  platform: string;
  businessProfileId: number;
}


