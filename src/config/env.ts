import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

/**
 * PRODUCTION-GRADE: Environment Configuration Schema
 * Validates all required variables at startup to prevent runtime failures.
 */
const envSchema = z.object({
  // ── Core Server ────────────────────────────────────────────────────────────
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(8080),
  SENTRY_DSN: z.string().optional(),
  DATABASE_URL: z.string().url(),
  TRUST_PROXY: z
    .string()
    .optional()
    .default("1")
    .transform((val) => {
      if (val === "0" || val === "false") return false;
      const n = parseInt(val, 10);
      return isNaN(n) ? 1 : n;
    }),
  
  // ── Authentication ─────────────────────────────────────────────────────────
  JWT_SECRET: z.string().min(8),
  JWT_REFRESH_SECRET: z.string().min(8),
  VERIFICATION_TOKEN_SECRET: z.string().min(8),
  PASSWORD_RESET_TOKEN_SECRET: z.string().min(8),
  GOOGLE_AUTH_CLIENT_ID: z.string().min(1).optional(),
  
  // ── Meta / Facebook ────────────────────────────────────────────────────────
  FB_API_URL: z.string().url().default("https://graph.facebook.com/v25.0"),
  FB_APP_ID: z.string().min(1),
  FB_APP_SECRET: z.string().min(1),
  FB_AUTH_APP_ID: z.string().min(1).optional(),
  FB_AUTH_APP_SECRET: z.string().min(1).optional(),
  FB_SYSTEM_USER_ACCESS_TOKEN: z.string().min(1),
  MESSENGER_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  FB_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  
  // ── AI Engine & ML Services ────────────────────────────────────────────────
  GEMINI_API_KEY: z.string().min(1),
  REPLICATE_API_TOKEN: z.string().optional(),
  ML_SERVICE_URL: z.string().url().optional(),
  ML_API_KEY: z.string().optional(),
  RAG_MIN_SIMILARITY: z.coerce.number().optional().default(0.25),
  AI_CHAT_RESPONSE_DEADLINE_MS: z.coerce.number().int().min(1000).max(60000).default(60000),
  AI_CHAT_RAG_TIMEOUT_MS: z.coerce.number().int().min(250).max(10000).default(10000),
  AI_CHAT_PREP_LOOKUP_TIMEOUT_MS: z.coerce.number().int().min(100).max(5000).default(5000),
  AI_CHAT_MODEL_TIERS: z
    .string()
    .default("gemini-3.1-flash-lite-preview,gemini-3-flash-preview,gemini-2.5-flash"),
  AI_CHAT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(4096).default(1024),
  
  // ── Google Cloud / Vertex AI ───────────────────────────────────────────────
  GOOGLE_CLOUD_PROJECT_ID: z.string().optional(),
  GOOGLE_CLOUD_LOCATION: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),

  // ── Microservices ──────────────────────────────────────────────────────────
  SCRAPING_SERVICE_URL: z.string().url().optional(),
  BACKEND_URL: z.string().url().optional(),
  
  // ── Infrastructure & Security ──────────────────────────────────────────────
  REDIS_URL: z.string().url(),
  FRONTEND_URL: z.string().url(),
  ADMIN_IP_WHITELIST: z.string().optional(),
  
  // ── Cloudflare R2 ──────────────────────────────────────────────────────────
  R2_ACCESS_KEY: z.string().min(1),
  R2_SECRET_KEY: z.string().min(1),
  CF_ACCOUNT_ID: z.string().min(1),
  R2_BUCKET_NAME: z.string().min(1),
  R2_PUBLIC_URL: z.string().url(),
  
  // ── Cloudinary ─────────────────────────────────────────────────────────────
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  // ── Email / SMTP ───────────────────────────────────────────────────────────
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z.string().optional().default("false").transform((val) => val === "true"),
  SMTP_USER: z.string().min(1),
  SMTP_PASS: z.string().min(1),
  MAIL_FROM: z.string().default("Wkil <noreply@wkil.app>"),
});

// ── Validation ───────────────────────────────────────────────────────────────
const _env = envSchema.safeParse(process.env);

if (!_env.success) {
  console.error(
    "❌ Invalid environment variables:",
    JSON.stringify(_env.error.format(), null, 2)
  );
  process.exit(1);
}

export const env = _env.data;
export default env;
