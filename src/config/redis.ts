import { ConnectionOptions } from "bullmq";
import Redis from "ioredis";
import { logger } from "../utils/logger";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

/**
 * Standalone Redis Client for custom operations.
 */
export const redisClient = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  tls: REDIS_URL.startsWith("rediss://")
    ? { rejectUnauthorized: false }
    : undefined,
});

redisClient.on("connect", () =>
  logger.info("Redis: Standalone client connected"),
);
redisClient.on("error", (err) =>
  logger.error("Redis: Standalone client error", { error: err.message }),
);

/**
 * BullMQ Connection Configuration.
 * Note: BullMQ requires maxRetriesPerRequest to be null.
 */
export const bullConnection: ConnectionOptions = {
  host: new URL(REDIS_URL).hostname,
  port: Number(new URL(REDIS_URL).port) || 6379,
  username: new URL(REDIS_URL).username || undefined,
  password: new URL(REDIS_URL).password || undefined,
  tls: REDIS_URL.startsWith("rediss://")
    ? { rejectUnauthorized: false }
    : undefined,
  maxRetriesPerRequest: null,
};
