import { Request, Response } from "express";
import {
  getDashboardActivity,
  getDashboardStats,
  getUnifiedDashboardStats,
} from "./dashboard.service";

export const getDashboardActivityController = async (
  req: Request,
  res: Response
) => {
  const userId = (req as any).user.id;
  const { limit } = req.query as any;

  const activity = await getDashboardActivity(userId, limit);
  res.status(200).json({ data: activity });
};

export const getDashboardStatsController = async (
  req: Request,
  res: Response
) => {
  const userId = (req as any).user.id;
  const { days } = req.query as any;

  const stats = await getDashboardStats(userId, days);
  res.status(200).json({ data: stats });
};

export const getUnifiedDashboardStatsController = async (
  req: Request,
  res: Response
) => {
  const userId = (req as any).user.id;
  const role = (req as any).user.role;
  const { days } = req.query as any;

  const stats = await getUnifiedDashboardStats(userId, role, days);
  res.status(200).json({ data: stats });
};


