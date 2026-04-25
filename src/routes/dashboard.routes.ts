import { Router } from "express";
import { authenticateToken } from "../middlewares/auth.middleware";
import {
  getDashboardActivityController,
  getDashboardStatsController,
  getUnifiedDashboardStatsController,
} from "../controllers/dashboard.controller";
import { validate } from "../middlewares/validate.middleware";
import { dashboardQuerySchema } from "../validations/dashboard.validation";

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

export default dashboardRoutes;


