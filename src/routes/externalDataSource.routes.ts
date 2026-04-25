import { Router, Request, Response, NextFunction } from "express";
import { authenticateToken } from "../middlewares/auth.middleware";
import prisma from "../config/prisma";
import { validate } from "../middlewares/validate.middleware";
import {
  dataSourceSchema,
  updateDataSourceSchema,
  getDataSourceSchema,
  deleteDataSourceSchema,
} from "../validations/dataSource.validation";
import { AppError } from "../middlewares/errorHandler.middleware";

const externalDataSourceRoutes = Router();

// Middleware to ensure user owns the business profile
const authorizeBusinessProfile = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const userId = (req as any).user.id;
  const profileId = parseInt(req.params.profileId);

  const profile = await prisma.businessProfile.findUnique({
    where: { id: profileId, userId },
  });

  if (!profile) {
    throw new AppError("Unauthorized access to business profile", 403);
  }

  next();
};

// Get all data sources for a profile
externalDataSourceRoutes.get(
  "/business-profiles/:profileId",
  authenticateToken,
  validate(getDataSourceSchema),
  authorizeBusinessProfile,
  async (req: Request, res: Response) => {
    const profileId = parseInt(req.params.profileId);
    const sources = await prisma.externalDataSource.findMany({
      where: { businessProfileId: profileId },
    });
    return res.json(sources);
  },
);

// Create or configure a new external data source
externalDataSourceRoutes.post(
  "/business-profiles/:profileId",
  authenticateToken,
  validate(dataSourceSchema),
  authorizeBusinessProfile,
  async (req: Request, res: Response) => {
    const profileId = parseInt(req.params.profileId);
    const {
      name,
      description,
      apiUrl,
      method,
      headers,
      queryParams,
      expectedParamsSchema,
      isActive,
    } = req.body;

    const newSource = await prisma.externalDataSource.create({
      data: {
        businessProfileId: profileId,
        name,
        description,
        apiUrl,
        method: method || "GET",
        headers,
        queryParams,
        expectedParamsSchema,
        isActive: isActive !== undefined ? isActive : true,
      },
    });

    return res.json({ success: true, source: newSource });
  },
);

// Update an existing external data source
externalDataSourceRoutes.put(
  "/business-profiles/:profileId/:sourceId",
  authenticateToken,
  validate(updateDataSourceSchema),
  authorizeBusinessProfile,
  async (req: Request, res: Response) => {
    const profileId = parseInt(req.params.profileId);
    const sourceId = parseInt(req.params.sourceId);
    const {
      name,
      description,
      apiUrl,
      method,
      headers,
      queryParams,
      expectedParamsSchema,
      isActive,
    } = req.body;

    const updatedSource = await prisma.externalDataSource.updateMany({
      where: { id: sourceId, businessProfileId: profileId },
      data: {
        name,
        description,
        apiUrl,
        method,
        headers,
        queryParams,
        expectedParamsSchema,
        isActive,
      },
    });

    if (updatedSource.count === 0) {
      throw new AppError("Data source not found or unauthorized", 404);
    }

    return res.json({ success: true, count: updatedSource.count });
  },
);

// Delete an external data source
externalDataSourceRoutes.delete(
  "/business-profiles/:profileId/:sourceId",
  authenticateToken,
  validate(deleteDataSourceSchema),
  authorizeBusinessProfile,
  async (req: Request, res: Response) => {
    const profileId = parseInt(req.params.profileId);
    const sourceId = parseInt(req.params.sourceId);

    await prisma.externalDataSource.deleteMany({
      where: { id: sourceId, businessProfileId: profileId },
    });

    return res.json({ success: true });
  },
);

export default externalDataSourceRoutes;
