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
} from "./middlewares/rateLimit.middleware";
import authRoutes from "./routes/auth.routes";
import dashboardRoutes from "./routes/dashboard.routes";
import os from "os";
import scrapeRoutes from "./routes/scraping/scrape";
import businessProfileRouts from "./routes/buisnessProfile.routes";
import messengerRoutes from "./routes/meta/messenger.routes";
import whatsappRoutes from "./routes/meta/whatsapp.routes";

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

app.use(
  "/v1/messenger/webhook",
  messengerWebhookLimiter,
  express.raw({ type: "application/json" }),
);
app.use("/v1/messenger", messengerRoutes);

app.use(
  "/v1/whatsapp/webhook",
  whatsappWebhookLimiter,
  express.raw({ type: "application/json" }),
);
app.use("/v1/whatsapp", whatsappRoutes);

// Security middleware
app.use(securityHeaders);
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Request processing middleware
app.use(sanitizeRequest);
app.use(requestSizeLimit);

// General rate limiting
app.use(generalLimiter);

// Routes
app.use("/v1/auth", authRoutes);
app.use("/v1/users", userRoutes);
app.use("/v1/content", contentRoutes);
app.use("/v1/facebook", facebookRoutes);
app.use("/v1/leads", leadRoutes);
app.use("/v1/admin", adminRoutes);
app.use("/v1/manager", managerRoutes);
app.use("/v1/dashboard", dashboardRoutes);
app.use("/v1/scrape", scrapeRoutes);
app.use("/v1/business-profile", businessProfileRouts);

// Health check endpoint
app.get("/v1/health", (req, res) => {
  res.status(200).json({
    status: "OK",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    cpuLoad: os.loadavg(),
    os: os.platform(),
  });
});

export default app;
