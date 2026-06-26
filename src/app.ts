import * as Sentry from "@sentry/node";
import express from "express";
import { env } from "@config/env";
import cors from "cors";
import cookieParser from "cookie-parser";
import adminRoutes from "@modules/admin/core/admin.routes";
import managerRoutes from "@modules/admin/manager/manager.routes";
import leadRoutes, {
  publicLeadRoutes,
} from "@modules/business/lead/lead.routes";
import customerRoutes from "@modules/business/customer/customer.routes";
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
import mobileAuthRoutes from "@modules/auth/mobile/mobileAuth.routes";
import { mobileCorsOptions } from "@middlewares/mobileCors.middleware";
import dashboardRoutes from "@modules/analytics/dashboard/dashboard.routes";
import os from "os";
import scrapeRoutes from "@modules/scraping/scrape";
import businessProfileRoutes from "@modules/business/profile/business.routes";
import messengerRoutes from "@modules/meta/messenger/messenger.routes";
import whatsappRoutes from "@modules/meta/whatsapp/whatsapp.routes";
import agentActionRoutes from "@modules/integrations/external/agentAction.routes";
import widgetPublicRoutes from "@modules/widget/widget.public.routes";
import widgetRoutes from "@modules/widget/widget.routes";
import aiAnalyticsRoutes from "@modules/analytics/ai/analytics.routes";
import conversationsRoutes from "@modules/inbox/inbox.routes";
import mediaRoutes from "@modules/media/meta-media.routes";
import mediaLibraryRoutes from "@modules/media/media.routes";
import docsRoutes from "@modules/docs/docs.routes";
import { identifyUserForRateLimit } from "@middlewares/identify.middleware";
import { errorHandler } from "@middlewares/errorHandler.middleware";
import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import missionControlRouter from "@modules/admin/mission-control/missionControl.routes";
import { generateCsrfToken, validateCsrfToken } from "@middlewares/csrf.middleware";
import { authenticateToken, requireAdmin, requireVerified } from "@modules/auth/core/auth.middleware";
import { runHealthChecks, allCriticalOk } from "@utils/healthChecks";

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

// ── Mobile sub-app ────────────────────────────────────────────────────────
// Dedicated Express sub-app with its own narrow CORS policy (allows
// only no-origin / "null" origin / configured web origins) + the
// public mobile auth routes. Mounted BEFORE the global CORS so the
// global dashboard policy does not apply to it.
const mobileApp = express.Router();
mobileApp.use(cors(mobileCorsOptions));
mobileApp.use(express.json({ limit: "10mb" }));
mobileApp.use(mobileAuthRoutes);
app.use("/v1/mobile", mobileApp);

// ── Routes ───────────────────────────────────────────────────────────────────
app.use("/v1/auth", authRoutes);

// Public/Webhook Routes (Meta sends payloads here without Bearer tokens)
app.use("/v1/messenger", messengerRoutes);
app.use("/v1/whatsapp", whatsappRoutes);
app.use("/v1/leads", publicLeadRoutes);

// API contract and interactive documentation
app.use("/", docsRoutes);

// ── Health probes (public) ──────────────────────────────────────────────────
// Liveness: process is alive. No dependency checks. Used by K8s liveness probe.
app.get("/v1/live", (_req, res) => {
  res.status(200).json({ status: "alive", timestamp: new Date().toISOString() });
});

// Readiness: critical deps are up. Used by K8s readiness probe / load balancer.
// Returns 200 with { status: "ready" } when all critical checks pass,
// 503 with { status: "not_ready", failed: [...] } otherwise.
// Body intentionally contains no per-dependency details — that lives at /v1/admin/health.
app.get("/v1/ready", async (_req, res) => {
  try {
    const report = await runHealthChecks();
    const failed = report.checks.filter((c) => c.critical && !c.ok).map((c) => c.name);
    if (allCriticalOk(report)) {
      res.status(200).json({ status: "ready", timestamp: new Date().toISOString() });
    } else {
      res.status(503).json({
        status: "not_ready",
        failed,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err: any) {
    logger.error("ready_check.unhandled_error", { error: err?.message });
    res.status(503).json({ status: "not_ready", error: "health check failed" });
  }
});

// Legacy /v1/health endpoint — kept for backward compat, behaves like /v1/ready.
app.get("/v1/health", async (_req, res) => {
  try {
    const report = await runHealthChecks();
    const failed = report.checks.filter((c) => c.critical && !c.ok).map((c) => c.name);
    if (allCriticalOk(report)) {
      res.status(200).json({
        status: "healthy",
        database: "UP",
        timestamp: new Date().toISOString(),
        system: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          cpu: os.loadavg(),
          platform: process.platform,
        },
      });
    } else {
      res.status(503).json({
        status: "degraded",
        database: failed.includes("postgres") ? "DOWN" : "UP",
        failed,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (err: any) {
    logger.error("health_check.unhandled_error", { error: err?.message });
    res.status(503).json({ status: "degraded", database: "DOWN" });
  }
});

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
app.use("/v1/customers", customerRoutes);
app.use("/v1/admin", adminRoutes);
app.use("/v1/admin/mission-control", missionControlRouter);
app.use("/v1/manager", managerRoutes);
app.use("/v1/dashboard", dashboardRoutes);
app.use("/v1/scrape", scrapeRoutes);
app.use("/v1/business-profile", businessProfileRoutes);
app.use("/v1/agent-actions", agentActionRoutes);
app.use("/v1/widget", widgetRoutes);
app.use("/v1/analytics", aiAnalyticsRoutes);
app.use("/v1/media", mediaLibraryRoutes);

// Admin-only detailed health (for admin dashboard)
app.get(
  "/v1/admin/health",
  authenticateToken,
  requireVerified,
  requireAdmin,
  async (_req, res) => {
    try {
      const report = await runHealthChecks();
      const healthy = allCriticalOk(report);
      res.status(healthy ? 200 : 503).json({
        status: healthy ? "healthy" : "degraded",
        timestamp: new Date().toISOString(),
        checks: report.checks,
        system: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          cpu: os.loadavg(),
          platform: process.platform,
          nodeVersion: process.version,
          pid: process.pid,
        },
      });
    } catch (err: any) {
      logger.error("admin_health_check.unhandled_error", { error: err?.message });
      res.status(503).json({ status: "degraded", error: "health check failed" });
    }
  },
);

// Sentry Error Handler (must be before custom error handlers)
Sentry.setupExpressErrorHandler(app);

// Global Error Handler (must be last middleware)
app.use(errorHandler);

export default app;






