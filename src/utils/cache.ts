import { redisClient } from "@config/redis";
import { logger } from "./logger";

/**
 * ─── Unified Redis Caching Utility ───────────────────────────────────────────
 * Replaces manual in-memory Maps with a stable, persistent Redis layer.
 * Ensures data consistency across multiple server instances and prevents
 * data loss during server restarts.
 */
export const cache = {
  /**
   * Retrieves a typed value from the cache.
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const data = await redisClient.get(key);
      if (!data) return null;
      return JSON.parse(data) as T;
    } catch (err: any) {
      logger.error("cache.get_failed", { key, error: err.message });
      return null;
    }
  },

  /**
   * Sets a value in the cache with an optional TTL (in seconds).
   */
  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    try {
      const data = JSON.stringify(value);
      if (ttlSeconds) {
        await redisClient.set(key, data, "EX", ttlSeconds);
      } else {
        await redisClient.set(key, data);
      }
    } catch (err: any) {
      logger.error("cache.set_failed", { key, error: err.message });
    }
  },

  /**
   * Removes a value from the cache.
   */
  async delete(key: string): Promise<void> {
    try {
      await redisClient.del(key);
    } catch (err: any) {
      logger.error("cache.delete_failed", { key, error: err.message });
    }
  },

  /**
   * ELITE TIER: Get or Set Pattern
   * Attempts to get a value from cache; if missing, executes the fetcher,
   * caches the result, and returns it.
   */
  async getOrSet<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttlSeconds?: number
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const fresh = await fetcher();
    
    // Only cache if the fresh data is not null/undefined to prevent "negative caching"
    if (fresh !== null && fresh !== undefined) {
      await this.set(key, fresh, ttlSeconds);
    }
    
    return fresh;
  },
};

