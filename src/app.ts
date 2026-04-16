import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import adminRoutes from "./routes/admin.routes";
import managerRoutes from "./routes/manager.routes";
import leadRoutes from "./routes/lead.routes";
import facebookRoutes from "./routes/meta/facebook.routes";
import userRoutes from "./routes/user.routes";
import contentRoutes from "./routes/content.routes";
import {
  securityHeaders,
  corsOptions,
  sanitizeRequest,
  requestSizeLimit,
} from "./middlewares/security.middleware";
import {
  generalLimiter,
  messengerWebhookLimiter,
  whatsappWebhookLimiter,
  widgetChatLimiter,
} from "./middlewares/rateLimit.middleware";
import authRoutes from "./routes/auth.routes";
import dashboardRoutes from "./routes/dashboard.routes";
import os from "os";
import scrapeRoutes from "./routes/scraping/scrape";
import businessProfileRouts from "./routes/buisnessProfile.routes";
import messengerRoutes from "./routes/meta/messenger.routes";
import whatsappRoutes from "./routes/meta/whatsapp.routes";
import crmRoutes from "./routes/crm.routes";
import externalDataSourceRoutes from "./routes/externalDataSource.routes";
import widgetPublicRoutes from "./routes/widget.public.routes";
import widgetRoutes from "./routes/widget.routes";
import aiAnalyticsRoutes from "./routes/aiAnalytics.routes";
import conversationsRoutes from "./routes/meta/conversations.routes";
import mediaRoutes from "./routes/meta/media.routes";
import mediaLibraryRoutes from "./routes/media.routes";
import { errorHandler } from "./middlewares/errorHandler.middleware";
import prisma from "./config/prisma";
import { logger } from "./utils/logger";

const app = express();

// Behind ngrok / load balancers Meta sends X-Forwarded-For; required for express-rate-limit
// IP keys and avoids ERR_ERL_UNEXPECTED_X_FORWARDED_FOR. Set TRUST_PROXY=0 to disable.
if (process.env.TRUST_PROXY === "0" || process.env.TRUST_PROXY === "false") {
  app.set("trust proxy", false);
} else {
  const n = Number(process.env.TRUST_PROXY);
  app.set(
    "trust proxy",
    Number.isFinite(n) && n >= 0 ? n : 1,
  );
}

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

// ── Routes ───────────────────────────────────────────────────────────────────
app.use("/v1/auth", authRoutes);
app.use("/v1/users", userRoutes);
app.use("/v1/content", contentRoutes);
app.use("/v1/facebook", facebookRoutes);
app.use("/v1/messenger", messengerRoutes);
app.use("/v1/whatsapp", whatsappRoutes);
app.use("/v1/meta/media", mediaRoutes);
app.use("/v1/meta/conversations", conversationsRoutes);
app.use("/v1/leads", leadRoutes);
app.use("/v1/admin", adminRoutes);
app.use("/v1/manager", managerRoutes);
app.use("/v1/dashboard", dashboardRoutes);
app.use("/v1/scrape", scrapeRoutes);
app.use("/v1/business-profile", businessProfileRouts);
app.use("/v1/crm", crmRoutes);
app.use("/v1/external-data", externalDataSourceRoutes);
app.use("/v1/widget", widgetRoutes);
app.use("/v1/analytics", aiAnalyticsRoutes);
app.use("/v1/media", mediaLibraryRoutes);

// Health check endpoint
app.get("/v1/health", async (req, res) => {
  let dbStatus = "UP";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    dbStatus = "DOWN";
    logger.error("Health check: Database connection failed", { error: err });
  }

  res.status(dbStatus === "UP" ? 200 : 503).json({
    status: dbStatus === "UP" ? "OK" : "PARTIAL_OUTAGE",
    database: dbStatus,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    cpuLoad: os.loadavg(),
  });
});

// Global Error Handler (must be last middleware)
app.use(errorHandler);

export default app;
