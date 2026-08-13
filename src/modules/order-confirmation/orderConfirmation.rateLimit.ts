import { randomUUID } from "node:crypto";
import { redisClient } from "@config/redis";

const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 60;
const REDIS_FAILURE_RETRY_MS = 5_000;

const slidingWindowScript = `
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window_ms)
local count = redis.call('ZCARD', KEYS[1])

if count >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local retry_ms = window_ms
  if oldest[2] then
    retry_ms = tonumber(oldest[2]) + window_ms - now
  end
  if retry_ms < 1 then
    retry_ms = 1
  end
  return { 0, retry_ms }
end

redis.call('ZADD', KEYS[1], now, member)
redis.call('PEXPIRE', KEYS[1], window_ms)
return { 1, 0 }
`;

function parsePermitResult(result: unknown): number | null {
  if (Array.isArray(result)) {
    const permitted = Number(result[0]);
    const retryAfter = Number(result[1]);
    return permitted === 1 ? null : Math.max(1, retryAfter || REDIS_FAILURE_RETRY_MS);
  }

  return Number(result) === 1 ? null : REDIS_FAILURE_RETRY_MS;
}

/**
 * Atomically reserves one outbound WhatsApp message for a business profile.
 * A Redis failure fails closed so an outage cannot bypass the tenant cap.
 */
export async function acquireBusinessSendPermit(
  businessProfileId: number,
): Promise<number | null> {
  const key = `order-confirmations:send:${businessProfileId}`;
  const now = Date.now();

  try {
    const result = await redisClient.eval(
      slidingWindowScript,
      1,
      key,
      String(now),
      String(WINDOW_MS),
      String(DEFAULT_LIMIT),
      `${now}:${randomUUID()}`,
    );

    return parsePermitResult(result);
  } catch {
    return REDIS_FAILURE_RETRY_MS;
  }
}
