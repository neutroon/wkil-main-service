import { ConnectionOptions } from "bullmq";
import Redis from "ioredis";
import { logger } from "@utils/logger";
import { env } from "./env";

const REDIS_URL = env.REDIS_URL;

/**
 * Standalone Redis Client for custom operations.
 *
 * Two settings below are the production-readiness fix that prevents the
 * request-thread from hanging when Redis is unreachable:
 *  - `enableOfflineQueue: false` — commands fail immediately when the
 *    connection is broken, instead of queuing forever waiting for reconnect.
 *  - `commandTimeout: 5_000` — bounds any single command to 5s.
 *
 * `maxRetriesPerRequest: null` is kept (BullMQ requires it).
 */
export const redisClient = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableOfflineQueue: false,
  commandTimeout: 5_000,
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

export const bullQueuePrefix =
  env.NODE_ENV === "production" ? "wkil-production" : "wkil-development";
