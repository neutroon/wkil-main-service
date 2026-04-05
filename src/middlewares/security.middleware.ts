import helmet from "helmet";
import { Request, Response, NextFunction } from "express";

// Security headers configuration
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
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

    if (process.env.NODE_ENV === "development") {
      // In development, allow any localhost origin
      if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
        return callback(null, true);
      }
    }

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    callback(new Error("Not allowed by CORS"));
  },
  credentials: true, // Allow cookies
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
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
export const adminIPWhitelist = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const adminIPs = process.env.ADMIN_IP_WHITELIST?.split(",") || [];

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
