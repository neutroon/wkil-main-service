import { ConnectionOptions } from "bullmq";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

/**
 * BullMQ Connection Configuration.
 * Note: BullMQ requires maxRetriesPerRequest to be null.
 */
export const bullConnection: ConnectionOptions = {
  url: REDIS_URL,
  maxRetriesPerRequest: null,
};

/**
 * Standalone Redis Client for custom operations.
 */
export const redisClient = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});
