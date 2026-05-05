import express from "express";
import { env } from "@config/env";
import cors from "cors";
import cookieParser from "cookie-parser";
import adminRoutes from "@modules/admin/core/admin.routes";
import managerRoutes from "@modules/admin/manager/manager.routes";
import leadRoutes from "@modules/business/lead/lead.routes";
import facebookRoutes from "@modules/meta/facebook/facebook.routes";
import userRoutes from "@modules/auth/user/user.routes";
import contentRoutes from "@modules/content/content.routes";
import {
  securityHeaders,
  corsOptions,
  sanitizeRequest,
  requestSizeLimit,
} from "@middlewares/security.middleware";
import {
  generalLimiter,
  messengerWebhookLimiter,
  whatsappWebhookLimiter,
  widgetChatLimiter,
} from "@middlewares/rateLimit.middleware";
import authRoutes from "@modules/auth/core/auth.routes";
import dashboardRoutes from "@modules/analytics/dashboard/dashboard.routes";
import os from "os";
import scrapeRoutes from "@modules/scraping/scrape";
import businessProfileRoutes from "@modules/business/profile/business.routes";
import messengerRoutes from "@modules/meta/messenger/messenger.routes";
import whatsappRoutes from "@modules/meta/whatsapp/whatsapp.routes";
import crmRoutes from "@modules/integrations/crm/crm.routes";
import externalDataSourceRoutes from "@modules/integrations/external/external.routes";
import widgetPublicRoutes from "@modules/widget/widget.public.routes";
import widgetRoutes from "@modules/widget/widget.routes";
import aiAnalyticsRoutes from "@modules/analytics/ai/analytics.routes";
import conversationsRoutes from "@modules/inbox/inbox.routes";
import mediaRoutes from "@modules/media/meta-media.routes";
import mediaLibraryRoutes from "@modules/media/media.routes";
import { identifyUserForRateLimit } from "@middlewares/identify.middleware";
import { errorHandler } from "@middlewares/errorHandler.middleware";
import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import missionControlRouter from "@modules/admin/mission-control/missionControl.routes";
import { generateCsrfToken, validateCsrfToken } from "@middlewares/csrf.middleware";

const app = express();

// Behind ngrok / load balancers Meta sends X-Forwarded-For; required for express-rate-limit
app.set("trust proxy", env.TRUST_PROXY);

// ── Global middleware (must come BEFORE all routes) ──────────────────────────
app.use(securityHeaders);

// Public web widget: bypass global CORS; per-install allowlist in widgetInstallAndCors
const widgetPublicApp = express.Router();

// Permissive CORS for the public router prefix (we handle real auth/origin check in the middleware)
widgetPublicApp.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Widget-Site-Key, Authorization, Accept, X-Requested-With");
  res.setHeader("Access-Control-Max-Age", "7200");
  
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

widgetPublicApp.use(express.json({ limit: "32kb" }));
widgetPublicApp.use(generalLimiter);
widgetPublicApp.use(widgetChatLimiter);
widgetPublicApp.use(widgetPublicRoutes);
app.use("/v1/public/widget", widgetPublicApp);

app.use(cors(corsOptions));       // ← CORS for dashboard / authenticated API
app.use(cookieParser());
app.use(sanitizeRequest);
app.use(requestSizeLimit);
app.use(generateCsrfToken); // Set CSRF cookie on every response
app.use(identifyUserForRateLimit);
app.use(generalLimiter);

// ── Raw-body paths (declared before express.json()) ──────────────────────────
// Meta requires HMAC verification against raw bytes, so these webhook paths
// use express.raw() instead of the JSON parser mounted below.
app.use(
  "/v1/messenger/webhook",
  messengerWebhookLimiter,
  express.raw({ type: "application/json" }),
);
app.use(
  "/v1/whatsapp/webhook",
  whatsappWebhookLimiter,
  express.raw({ type: "application/json" }),
);

// ── JSON / URL-encoded body parser (all other routes) ────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

import { authenticateToken, requireVerified } from "@modules/auth/core/auth.middleware";

// ── Routes ───────────────────────────────────────────────────────────────────
app.use("/v1/auth", authRoutes);

// Public/Webhook Routes (Meta sends payloads here without Bearer tokens)
app.use("/v1/messenger", messengerRoutes);
app.use("/v1/whatsapp", whatsappRoutes);

// Protected Enterprise Routes (Require Authentication & Email Verification)
app.use(authenticateToken);
app.use(requireVerified);
app.use(validateCsrfToken); // Enforce CSRF on all protected mutating routes

app.use("/v1/users", userRoutes);
app.use("/v1/content", contentRoutes);
app.use("/v1/facebook", facebookRoutes);
app.use("/v1/meta/media", mediaRoutes);
app.use("/v1/meta/conversations", conversationsRoutes);
app.use("/v1/leads", leadRoutes);
app.use("/v1/admin", adminRoutes);
app.use("/v1/admin/mission-control", missionControlRouter);
app.use("/v1/manager", managerRoutes);
app.use("/v1/dashboard", dashboardRoutes);
app.use("/v1/scrape", scrapeRoutes);
app.use("/v1/business-profile", businessProfileRoutes);
app.use("/v1/crm", crmRoutes);
app.use("/v1/external-data", externalDataSourceRoutes);
app.use("/v1/widget", widgetRoutes);
app.use("/v1/analytics", aiAnalyticsRoutes);
app.use("/v1/media", mediaLibraryRoutes);

// Health check endpoint (System Vitals Diagnostic)
app.get("/v1/health", async (_req, res) => {
  let database = "UP";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    database = "DOWN";
    logger.error("Health check: Database connection failed", { error: err });
  }

  const status = database === "UP" ? "healthy" : "degraded";
  const statusCode = database === "UP" ? 200 : 503;

  res.status(statusCode).json({
    status,
    database,
    timestamp: new Date().toISOString(),
    system: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      cpu: os.loadavg(),
      platform: process.platform,
    },
  });
});

// Global Error Handler (must be last middleware)
app.use(errorHandler);

export default app;






