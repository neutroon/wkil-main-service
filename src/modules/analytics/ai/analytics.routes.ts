import { Router } from "express";
import { authenticateToken } from "@modules/auth/core/auth.middleware";
import { 
  getAiPerformanceController, 
  getAiCorrectionsController 
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

aiAnalyticsRoutes.get(
  "/corrections",
  authenticateToken,
  validate(aiAnalyticsQuerySchema),
  getAiCorrectionsController
);

export default aiAnalyticsRoutes;







