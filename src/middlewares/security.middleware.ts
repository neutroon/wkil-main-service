import helmet from "helmet";
import { env } from "../config/env";
import { Request, Response, NextFunction } from "express";

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
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    const allowedOrigins = [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:8080",
      "https://pagespilot.com",
      "https://www.pagespilot.com",
      "https://pagespilot.vercel.app",
      "https://pagespilot.netlify.app",
      "https://pagespilot.com",
      "https://app.pagespilot.com",
    ];

    if (env.NODE_ENV === "development") {
      // In development, allow any localhost origin
      if (
        origin.includes("localhost") ||
        origin.includes("127.0.0.1") ||
        origin.includes("trycloudflare.com")
      ) {
        return callback(null, true);
      }
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Dynamic production fallbacks
    if (origin.endsWith(".pagespilot.com") || origin.endsWith(".vercel.app") || origin === env.FRONTEND_URL) {
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
