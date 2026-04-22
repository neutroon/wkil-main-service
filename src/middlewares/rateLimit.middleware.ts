import rateLimit, { ipKeyGenerator } from "express-rate-limit";

// Key generator that prioritizes User ID over IP to prevent blocking entire offices/NATs
const getRateLimitKey = (req: any) => {
  if (req.user && req.user.id) {
    return `user:${req.user.id}`;
  }
  return ipKeyGenerator(req.ip || req.socket.remoteAddress || "unknown");
};

// General rate limiting
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Increased from 100 to allow smooth dashboard navigation
  message: {
    error: "Too many requests from this account, please try again later",
    code: "RATE_LIMIT_EXCEEDED",
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  keyGenerator: getRateLimitKey,
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
  validate: { trustProxy: false },
  skipSuccessfulRequests: true, // Don't count successful requests
});

// High-intensity security limiter for forgot-password and resend-verification
export const securityActionLimiter = rateLimit({
  windowMs: 30 * 60 * 1000, // 30 minutes
  max: 3, // Very strict: 3 attempts per half hour
  message: {
    error: "Too many security reset attempts, please try again in 30 minutes",
    code: "SECURITY_ACTION_LIMIT_EXCEEDED",
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
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
  validate: { trustProxy: false },
});

// Facebook API rate limiting
export const facebookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 150, // Increased from 30 to allow for page polling and multiple FB operations
  message: {
    error: "Facebook API rate limit exceeded, please try again later",
    code: "FACEBOOK_RATE_LIMIT_EXCEEDED",
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  keyGenerator: getRateLimitKey,
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
  validate: { trustProxy: false },
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
  validate: { trustProxy: false },
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
  validate: { trustProxy: false },
});

/** WhatsApp Cloud API may burst webhook deliveries same as Messenger. */
export const whatsappWebhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  message: {
    error: "Too many webhook requests",
    code: "WHATSAPP_WEBHOOK_RATE_LIMIT",
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
});

/** Public web widget chat: keyed by IP + site key (after JSON body is parsed). */
export const widgetChatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: {
    error: "Widget chat rate limit exceeded",
    code: "WIDGET_CHAT_RATE_LIMIT",
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: {
    trustProxy: false,
  },
  keyGenerator: (req) => {
    // Using the official ipKeyGenerator helper prevents the IPv6 validation warning
    const ip = ipKeyGenerator(req.ip || req.socket.remoteAddress || "unknown");
    const sk = String(
      req.headers["x-widget-site-key"] ??
        (req.body && typeof req.body === "object" && "siteKey" in req.body
          ? (req.body as { siteKey?: string }).siteKey
          : "") ??
        "na",
    );
    return `${ip}:${sk}`;
  },
});
