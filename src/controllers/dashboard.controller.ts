import { Request, Response } from "express";
import {
  getDashboardActivity,
  getDashboardStats,
  getUnifiedDashboardStats,
} from "../services/dashboard.service";

export const getDashboardActivityController = async (
  req: Request,
  res: Response
) => {
  try {
    const userId = (req as any).user.id;
    const limitParam = req.query.limit as string | undefined;
    const limit = limitParam ? parseInt(limitParam, 10) : undefined;

    const activity = await getDashboardActivity(userId, limit);
    res.status(200).json({ data: activity });
  } catch (error: any) {
    res.status(500).json({
      error: "Failed to fetch dashboard activity",
      details: error.message,
    });
  }
};

export const getDashboardStatsController = async (
  req: Request,
  res: Response
) => {
  try {
    const userId = (req as any).user.id;
    const daysParam = req.query.days as string | undefined;
    const days = daysParam ? parseInt(daysParam, 10) : undefined;

    const stats = await getDashboardStats(userId, days);
    res.status(200).json({ data: stats });
  } catch (error: any) {
    res.status(500).json({
      error: "Failed to fetch dashboard stats",
      details: error.message,
    });
  }
};
export const getUnifiedDashboardStatsController = async (
  req: Request,
  res: Response
) => {
  try {
    const userId = (req as any).user.id;
    const role = (req as any).user.role;
    const daysParam = req.query.days as string | undefined;
    const days = daysParam ? parseInt(daysParam, 10) : undefined;

    const stats = await getUnifiedDashboardStats(userId, role, days);
    res.status(200).json({ data: stats });
  } catch (error: any) {
    res.status(500).json({
      error: "Failed to fetch unified dashboard stats",
      details: error.message,
    });
  }
};
