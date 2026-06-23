import helmet from "helmet";
import { env } from "@config/env";
import { Request, Response, NextFunction } from "express";
import { logger } from "@utils/logger";

// Security headers configuration
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:", "http:", "*"],
      connectSrc: ["'self'", "https:", "http:", "*"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'", "https:", "http:", "*"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }, // CRITICAL: Allow images/media across subdomains
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
});

// CORS configuration
export const corsOptions = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ) => {
    // Debug logging for CORS issues
    logger.debug("CORS Check", { origin, nodeEnv: env.NODE_ENV });

    // Allow requests with no origin (like mobile apps or curl requests)
    // Also allow any origin in development to bypass CORS issues during testing
    if (!origin || env.NODE_ENV === "development") {
      return callback(null, true);
    }

    const allowedOrigins = [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:8080",
      "https://wkil.app",
      "https://www.wkil.app",
      "https://go.wkil.app",
      "https://app.wkil.app",
      "https://wkil.vercel.app",
      "https://wkil.netlify.app",
    ];

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Dynamic production fallbacks
    if (origin.endsWith(".wkil.app") || origin.endsWith(".vercel.app") || origin === env.FRONTEND_URL) {
      return callback(null, true);
    }

    logger.warn("CORS Blocked:", { origin });
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true, // Allow cookies
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "X-CSRF-Token",
    "ngrok-skip-browser-warning",
  ],
  exposedHeaders: ["Set-Cookie"],
  maxAge: 86400, // 24 hours
};

// Request sanitization middleware
export const sanitizeRequest = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Remove any potential XSS attempts from query parameters
  const sanitizeString = (str: string): string => {
    return str
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<[^>]*>/g, "")
      .trim();
  };

  // Sanitize query parameters
  if (req.query) {
    for (const key in req.query) {
      if (typeof req.query[key] === "string") {
        req.query[key] = sanitizeString(req.query[key] as string);
      }
    }
  }

  // Sanitize body parameters
  if (req.body && typeof req.body === "object") {
    const sanitizeObject = (obj: any): any => {
      if (typeof obj === "string") {
        return sanitizeString(obj);
      }
      if (Array.isArray(obj)) {
        return obj.map(sanitizeObject);
      }
      if (obj && typeof obj === "object") {
        const sanitized: any = {};
        for (const key in obj) {
          sanitized[key] = sanitizeObject(obj[key]);
        }
        return sanitized;
      }
      return obj;
    };

    req.body = sanitizeObject(req.body);
  }

  next();
};

// Request size limiting
export const requestSizeLimit = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const contentLength = parseInt(req.headers["content-length"] || "0");
  const maxSize = 10 * 1024 * 1024; // 10MB

  if (contentLength > maxSize) {
    return res.status(413).json({
      error: "Request entity too large",
      code: "REQUEST_TOO_LARGE",
      maxSize: "10MB",
    });
  }

  next();
};

// Allow Mission Control (Bull Board) to be embedded in the admin frontend iframe.
// Helmet's global config sets X-Frame-Options: SAMEORIGIN and a CSP without
// frame-ancestors, which blocks cross-origin framing. This middleware overrides
// both on the /v1/admin/mission-control route only.
export const missionControlFrameHeaders = (
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  res.removeHeader("X-Frame-Options");
  res.appendHeader(
    "Content-Security-Policy",
    [
      "frame-ancestors 'self'",
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:8080",
      "https://go.wkil.app",
      "https://*.wkil.app",
    ].join(" "),
  );
  next();
};

// IP whitelist for admin operations (optional)
export const requireAdminIP = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const adminIPs = env.ADMIN_IP_WHITELIST?.split(",") || [];

  if (adminIPs.length === 0) {
    // No whitelist configured, allow all
    return next();
  }

  const clientIP =
    req.ip || req.connection.remoteAddress || req.socket.remoteAddress;

  if (clientIP && adminIPs.includes(clientIP)) {
    return next();
  }

  return res.status(403).json({
    error: "Access denied from this IP address",
    code: "IP_NOT_ALLOWED",
  });
};

