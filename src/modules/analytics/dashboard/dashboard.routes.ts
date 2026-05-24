import { Router } from "express";
import { authenticateToken } from "@modules/auth/core/auth.middleware";
import {
  getDashboardActivityController,
  getDashboardStatsController,
  getUnifiedDashboardStatsController,
  recordSetupProgressEventController,
} from "./dashboard.controller";
import { validate } from "@middlewares/validate.middleware";
import {
  dashboardQuerySchema,
  setupProgressEventSchema,
} from "./dashboard.validation";

const dashboardRoutes = Router();

dashboardRoutes.get(
  "/activity",
  authenticateToken,
  validate(dashboardQuerySchema),
  getDashboardActivityController
);

dashboardRoutes.get(
  "/stats", 
  authenticateToken, 
  validate(dashboardQuerySchema),
  getDashboardStatsController
);

dashboardRoutes.get(
  "/unified", 
  authenticateToken, 
  validate(dashboardQuerySchema),
  getUnifiedDashboardStatsController
);

dashboardRoutes.post(
  "/setup-progress",
  authenticateToken,
  validate(setupProgressEventSchema),
  recordSetupProgressEventController
);

export default dashboardRoutes;









