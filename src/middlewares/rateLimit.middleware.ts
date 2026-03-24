import rateLimit from "express-rate-limit";

// General rate limiting
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    error: "Too many requests from this IP, please try again later",
    code: "RATE_LIMIT_EXCEEDED",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict rate limiting for authentication endpoints
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  message: {
    error: "Too many authentication attempts, please try again later",
    code: "AUTH_RATE_LIMIT_EXCEEDED",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Don't count successful requests
});

// Content generation rate limiting
export const contentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // Limit each IP to 20 content generations per hour
  message: {
    error: "Content generation limit exceeded, please try again later",
    code: "CONTENT_RATE_LIMIT_EXCEEDED",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Facebook API rate limiting
export const facebookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Limit each IP to 30 Facebook API calls per 15 minutes
  message: {
    error: "Facebook API rate limit exceeded, please try again later",
    code: "FACEBOOK_RATE_LIMIT_EXCEEDED",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Admin operations rate limiting
export const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Limit each IP to 50 admin operations per 15 minutes
  message: {
    error: "Admin operations rate limit exceeded, please try again later",
    code: "ADMIN_RATE_LIMIT_EXCEEDED",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Manager operations rate limiting
export const managerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Limit each IP to 50 manager operations per 15 minutes
  message: {
    error: "Manager operations rate limit exceeded, please try again later",
    code: "MANAGER_RATE_LIMIT_EXCEEDED",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Meta may burst webhook deliveries; allow a higher ceiling than general API. */
export const messengerWebhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  message: {
    error: "Too many webhook requests",
    code: "MESSENGER_WEBHOOK_RATE_LIMIT",
  },
  standardHeaders: true,
  legacyHeaders: false,
});
