import { Request, Response } from "express";
import { getAiPerformanceStats, getAiCorrections } from "./analytics.service";

export const getAiPerformanceController = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const role = (req as any).user.role;
  const { days, businessProfileId } = req.query as any;

  const stats = await getAiPerformanceStats(
    userId,
    role,
    days || 30,
    businessProfileId
  );

  res.status(200).json({ data: stats });
};

export const getAiCorrectionsController = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;
  const { limit, offset } = req.query as any;

  const data = await getAiCorrections(
    userId,
    limit || 50,
    offset || 0
  );

  res.status(200).json({ data });
};


