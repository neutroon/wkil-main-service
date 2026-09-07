import { CorsOptions } from "cors";
import { logger } from "@utils/logger";
import { isAllowedWkilWebOrigin } from "./origin-policy";

/**
 * CORS policy for the shared assistant gateway.
 *
 * Native fetch normally sends no Origin header. The literal "null" is also
 * accepted for native clients and local tooling; every request still crosses
 * the bearer/cookie authentication wall before any assistant data is read.
 */
export const assistantCorsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || origin === "null" || isAllowedWkilWebOrigin(origin)) {
      return callback(null, true);
    }
    logger.warn("assistant.cors_blocked", { origin });
    return callback(new Error("Not allowed by assistant CORS"), false);
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Authorization",
    "Content-Type",
    "Accept",
    "X-Requested-With",
    "X-Workspace-ID",
    "X-CSRF-Token",
    "X-Locale",
    "Last-Event-ID",
  ],
  exposedHeaders: ["X-Request-ID"],
  maxAge: 86400,
};

