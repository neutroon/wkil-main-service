import { Router } from "express";
import { authenticateToken } from "../middlewares/auth.middleware";
import {
  getDashboardActivityController,
  getDashboardStatsController,
  getUnifiedDashboardStatsController,
} from "../controllers/dashboard.controller";

const dashboardRoutes = Router();

dashboardRoutes.get(
  "/activity",
  authenticateToken,
  getDashboardActivityController
);

dashboardRoutes.get("/stats", authenticateToken, getDashboardStatsController);
dashboardRoutes.get("/unified", authenticateToken, getUnifiedDashboardStatsController);

export default dashboardRoutes;


