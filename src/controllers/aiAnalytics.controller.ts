import { Request, Response } from "express";
import { getAiPerformanceStats } from "../services/aiAnalytics.service";
import { logger } from "../utils/logger";

export const getAiPerformanceController = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const role = (req as any).user.role;
    const { days, businessProfileId } = req.query;

    const stats = await getAiPerformanceStats(
      userId,
      role,
      days ? parseInt(days as string, 10) : 30,
      businessProfileId ? parseInt(businessProfileId as string, 10) : undefined
    );

    res.status(200).json({ data: stats });
  } catch (error: any) {
    logger.error("analytics.ai_performance.error", { error: error.message });
    res.status(500).json({
      error: "Failed to fetch AI performance analytics",
      details: error.message,
    });
  }
};

export const getAiCorrectionsController = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const { limit, offset } = req.query;

    const data = await require("../services/aiAnalytics.service").getAiCorrections(
      userId,
      limit ? parseInt(limit as string, 10) : 50,
      offset ? parseInt(offset as string, 10) : 0
    );

    res.status(200).json({ data });
  } catch (error: any) {
    logger.error("analytics.ai_corrections.error", { error: error.message });
    res.status(500).json({
      error: "Failed to fetch AI correction history",
      details: error.message,
    });
  }
};
