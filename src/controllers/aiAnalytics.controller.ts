import { Request, Response } from "express";
import { getAiPerformanceStats } from "../services/aiAnalytics.service";
import { logger } from "../utils/logger";

export const getAiPerformanceController = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const { days, businessProfileId } = req.query;

    const stats = await getAiPerformanceStats(
      userId,
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
