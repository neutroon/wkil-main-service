import { CorsOptions } from "cors";
import { logger } from "@utils/logger";

/**
 * Narrow CORS policy for the `/v1/mobile/*` sub-app.
 *
 * Mobile clients (Dio, NSURLSession, OkHttp, axios on RN, ...) send the
 * literal `Origin: null` header. This policy only accepts:
 *   1. no Origin header (server-to-server)
 *   2. the literal "null" origin (mobile clients)
 *   3. the configured web origins (so the same endpoints can be tested
 *      from a browser during development)
 *
 * It does NOT accept arbitrary cross-site origins — that would defeat
 * the purpose of CORS.
 */
export const mobileCorsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (origin === "null") return callback(null, true);

    // Allow the same browser origins the dashboard accepts, so devs
    // can hit the mobile endpoints from a tool like Postman / Insomnia
    // that fakes an Origin header.
    const allowed = [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://localhost:8080",
      "https://wkil.app",
      "https://www.wkil.app",
      "https://app.wkil.app",
      "https://go.wkil.app",
    ];
    if (allowed.includes(origin)) return callback(null, true);
    if (origin.endsWith(".wkil.app")) return callback(null, true);

    logger.warn("mobile.cors_blocked", { origin });
    callback(new Error("Not allowed by mobile CORS"), false);
  },
  credentials: false, // mobile clients never send cookies
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Authorization",
    "Content-Type",
    "Accept",
    "X-Requested-With",
  ],
  maxAge: 86400,
};
