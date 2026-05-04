import axios from "axios";
import axiosRetry from "axios-retry";
import { mapFacebookGraphError } from "@modules/meta/facebook/facebookGraphError";
import { AppError } from "@middlewares/errorHandler.middleware";
import { logger } from "./logger";

/**
 * ─── Meta Delivery Client ────────────────────────────────────────────────────
 * A highly resilient Axios client strictly for Facebook Graph API interactions.
 * Features automated transient error recovery, rate limit backoffs, and
 * transparent error normalization into standard AppErrors.
 */
export const metaClient = axios.create();

// Configure Elite-Tier Exponential Backoff for Rate Limits & Transient Errors
axiosRetry(metaClient, {
  retries: 3,
  retryDelay: (retryCount, error) => {
    const mapped = mapFacebookGraphError(error);
    
    // Rate Limit codes: 4 (App), 17 (User), 32 (Page), 613 (Custom)
    const isRateLimit = [4, 17, 32, 613].includes(Number(mapped.code));
    
    if (isRateLimit) {
      // Aggressive backoff for Rate Limits to avoid triggering further bans
      return (60000 + Math.random() * 60000) * retryCount; // 1-2 mins per retry
    }
    
    // Standard exponential backoff for transient failures (codes 1, 2)
    return axiosRetry.exponentialDelay(retryCount);
  },
  retryCondition: (error) => {
    const mapped = mapFacebookGraphError(error);
    return mapped.isRetryable;
  },
  onRetry: (retryCount, error, requestConfig) => {
    const mapped = mapFacebookGraphError(error);
    const isRateLimit = [4, 17, 32, 613].includes(Number(mapped.code));
    logger.warn(`meta.api.retry_triggered`, {
      attempt: retryCount,
      errorCode: mapped.code,
      isRateLimit,
      url: requestConfig.url,
    });
  }
});

// Response Interceptor: Seamlessly normalize Graph API Errors into AppErrors
metaClient.interceptors.response.use(
  (response) => response,
  (error) => {
    // If we've already transformed this into an AppError (e.g. from a manual throw elsewhere), pass it down
    if (error instanceof AppError) return Promise.reject(error);

    const mapped = mapFacebookGraphError(error);
    
    logger.error("meta.api.request_failed_V25_VERIFIED", {
      message: mapped.message,
      code: mapped.code,
      status: mapped.status,
      subcode: mapped.subcode,
      url: error.config?.url,
    });
    
    const codePart = mapped.code !== undefined && mapped.code !== 0 ? ` (code: ${mapped.code})` : "";
    return Promise.reject(new AppError(`${mapped.message}${codePart}`, 502));
  }
);

/**
 * ─── Internal Microservices Client ───────────────────────────────────────────
 * A client for internal microservices (e.g., Python Scraper, ML Engines).
 * Enforces timeouts and standardizes internal error reporting.
 */
export const internalClient = axios.create({
  timeout: 30000, // 30 seconds default timeout
});

internalClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const message = error.response?.data?.error || error.message || "Internal Microservice Error";
    
    logger.error("internal.api.request_failed", {
      message,
      status: error.response?.status,
      url: error.config?.url,
    });
    
    return Promise.reject(new AppError(message, 502));
  }
);





