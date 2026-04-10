import { Router } from "express";
import { authenticateToken } from "../middlewares/auth.middleware";
import { getAiPerformanceController } from "../controllers/aiAnalytics.controller";

const aiAnalyticsRoutes = Router();

aiAnalyticsRoutes.get(
  "/ai-performance",
  authenticateToken,
  getAiPerformanceController
);

aiAnalyticsRoutes.get(
  "/corrections",
  authenticateToken,
  require("../controllers/aiAnalytics.controller").getAiCorrectionsController
);

export default aiAnalyticsRoutes;
