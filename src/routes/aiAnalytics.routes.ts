import { Router } from "express";
import { authenticateToken } from "../middlewares/auth.middleware";
import { 
  getAiPerformanceController, 
  getAiCorrectionsController 
} from "../controllers/aiAnalytics.controller";
import { validate } from "../middlewares/validate.middleware";
import { aiAnalyticsQuerySchema } from "../validations/aiAnalytics.validation";

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
