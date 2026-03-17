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
import { generalLimiter } from "./middlewares/rateLimit.middleware";
import authRoutes from "./routes/auth.routes";
import dashboardRoutes from "./routes/dashboard.routes";
import os from "os";
import scrapeRoutes from "./routes/scraping/scrape";

const app = express();

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
