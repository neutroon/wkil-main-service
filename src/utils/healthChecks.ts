import prisma from "@config/prisma";
import { redisClient, bullQueuePrefix } from "@config/redis";
import { env } from "@config/env";
import { logger } from "@utils/logger";

export type CheckName = "postgres" | "redis" | "bullmq" | "meta_api";

export interface HealthCheck {
  name: CheckName;
  ok: boolean;
  critical: boolean;
  latencyMs: number;
  error?: string;
  details?: Record<string, unknown>;
}

export interface HealthReport {
  checks: HealthCheck[];
  totalLatencyMs: number;
}

const TIMEOUT_POSTGRES_MS = 3_000;
const TIMEOUT_REDIS_MS = 2_000;
const TIMEOUT_BULLMQ_MS = 2_000;
const TIMEOUT_META_API_MS = 5_000;
const META_API_CACHE_TTL_MS = 30_000;

const withTimeout = async <T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} check timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const runCheck = async (
  name: CheckName,
  critical: boolean,
  fn: () => Promise<Record<string, unknown> | void>,
  timeoutMs: number,
): Promise<HealthCheck> => {
  const startedAt = Date.now();
  try {
    const details = await withTimeout(fn(), timeoutMs, name);
    return {
      name,
      ok: true,
      critical,
      latencyMs: Date.now() - startedAt,
      ...(details ? { details } : {}),
    };
  } catch (err: any) {
    const latencyMs = Date.now() - startedAt;
    logger.warn("health_check.failed", {
      name,
      critical,
      latencyMs,
      error: err?.message ?? String(err),
    });
    return {
      name,
      ok: false,
      critical,
      latencyMs,
      error: err?.message ?? String(err),
    };
  }
};

export const checkPostgres = (): Promise<HealthCheck> =>
  runCheck("postgres", true, async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { query: "SELECT 1" };
  }, TIMEOUT_POSTGRES_MS);

export const checkRedis = (): Promise<HealthCheck> =>
  runCheck("redis", true, async () => {
    const pong = await redisClient.ping();
    return { response: pong, status: redisClient.status };
  }, TIMEOUT_REDIS_MS);

export const checkBullWorkers = (): Promise<HealthCheck> =>
  runCheck("bullmq", true, async () => {
    if (redisClient.status !== "ready") {
      throw new Error(`Redis status: ${redisClient.status}`);
    }
    return {
      redisStatus: redisClient.status,
      bullmqPrefix: bullQueuePrefix,
      nodeEnv: env.NODE_ENV,
    };
  }, TIMEOUT_BULLMQ_MS);

interface MetaApiCacheEntry {
  result: HealthCheck;
  expiresAt: number;
}
let metaApiCache: MetaApiCacheEntry | null = null;

export const checkMetaApi = async (): Promise<HealthCheck> => {
  const now = Date.now();
  if (metaApiCache && metaApiCache.expiresAt > now) {
    return metaApiCache.result;
  }

  const appId = env.FB_APP_ID;
  const appSecret = env.FB_APP_SECRET;
  if (!appId || !appSecret) {
    const result: HealthCheck = {
      name: "meta_api",
      ok: false,
      critical: true,
      latencyMs: 0,
      error: "FB_APP_ID / FB_APP_SECRET not configured",
    };
    metaApiCache = { result, expiresAt: now + META_API_CACHE_TTL_MS };
    return result;
  }

  const startedAt = Date.now();
  try {
    const result = await withTimeout(
      fetch(
        `https://graph.facebook.com/v25.0/app?access_token=${appId}|${appSecret}`,
      ),
      TIMEOUT_META_API_MS,
      "meta_api",
    );
    const latencyMs = Date.now() - startedAt;
    if (!result.ok) {
      const body = await result.text().catch(() => "");
      const check: HealthCheck = {
        name: "meta_api",
        ok: false,
        critical: true,
        latencyMs,
        error: `Meta API returned ${result.status}`,
        details: { status: result.status, body: body.slice(0, 200) },
      };
      metaApiCache = { result: check, expiresAt: now + META_API_CACHE_TTL_MS };
      return check;
    }
    const check: HealthCheck = {
      name: "meta_api",
      ok: true,
      critical: true,
      latencyMs,
      details: { status: result.status },
    };
    metaApiCache = { result: check, expiresAt: now + META_API_CACHE_TTL_MS };
    return check;
  } catch (err: any) {
    const latencyMs = Date.now() - startedAt;
    const check: HealthCheck = {
      name: "meta_api",
      ok: false,
      critical: true,
      latencyMs,
      error: err?.message ?? String(err),
    };
    metaApiCache = { result: check, expiresAt: now + META_API_CACHE_TTL_MS };
    return check;
  }
};

export const runHealthChecks = async (): Promise<HealthReport> => {
  const startedAt = Date.now();
  const checks = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkBullWorkers(),
    checkMetaApi(),
  ]);
  return {
    checks,
    totalLatencyMs: Date.now() - startedAt,
  };
};

export const allCriticalOk = (report: HealthReport): boolean =>
  report.checks.filter((c) => c.critical).every((c) => c.ok);
