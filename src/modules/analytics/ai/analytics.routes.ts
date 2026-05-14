import { Router } from "express";
import { authenticateToken } from "@modules/auth/core/auth.middleware";
import { 
  getAiPerformanceController,
} from "./analytics.controller";
import { validate } from "@middlewares/validate.middleware";
import { aiAnalyticsQuerySchema } from "./aiAnalytics.validation";

const aiAnalyticsRoutes = Router();

aiAnalyticsRoutes.get(
  "/ai-performance",
  authenticateToken,
  validate(aiAnalyticsQuerySchema),
  getAiPerformanceController
);

export default aiAnalyticsRoutes;







