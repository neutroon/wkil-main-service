import { Router } from "express";
import { authenticateToken } from "../middlewares/auth.middleware";
import prisma from "../config/prisma";
import { Request, Response } from "express";

const externalDataSourceRoutes = Router();

// Middleware to ensure user owns the business profile
const authorizeBusinessProfile = async (req: Request, res: Response, next: Function) => {
  try {
    const userId = (req as any).user.id;
    const profileId = parseInt(req.params.profileId);
    
    if (isNaN(profileId)) {
      return res.status(400).json({ error: "Invalid profile ID" });
    }

    const profile = await prisma.businessProfile.findUnique({
      where: { id: profileId, userId },
    });

    if (!profile) {
      return res.status(403).json({ error: "Unauthorized access to business profile" });
    }

    next();
  } catch (error) {
    res.status(500).json({ error: "Server error during authorization" });
  }
};

// Get all data sources for a profile
externalDataSourceRoutes.get("/business-profiles/:profileId", authenticateToken, authorizeBusinessProfile, async (req: Request, res: Response) => {
  try {
    const profileId = parseInt(req.params.profileId);
    const sources = await prisma.externalDataSource.findMany({
      where: { businessProfileId: profileId },
    });
    return res.json(sources);
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

// Create or configure a new external data source
externalDataSourceRoutes.post("/business-profiles/:profileId", authenticateToken, authorizeBusinessProfile, async (req: Request, res: Response) => {
  try {
    const profileId = parseInt(req.params.profileId);
    const { name, description, apiUrl, method, headers, queryParams, expectedParamsSchema, isActive } = req.body;

    if (!name || !apiUrl || !description) {
        return res.status(400).json({ error: "name, description, and apiUrl are required" });
    }

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
      }
    });

    return res.json({ success: true, source: newSource });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

// Update an existing external data source
externalDataSourceRoutes.put("/business-profiles/:profileId/:sourceId", authenticateToken, authorizeBusinessProfile, async (req: Request, res: Response) => {
  try {
    const profileId = parseInt(req.params.profileId);
    const sourceId = parseInt(req.params.sourceId);
    const { name, description, apiUrl, method, headers, queryParams, expectedParamsSchema, isActive } = req.body;

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
      }
    });

    if (updatedSource.count === 0) {
      return res.status(404).json({ error: "Data source not found or unauthorized" });
    }

    return res.json({ success: true, count: updatedSource.count });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

// Delete an external data source
externalDataSourceRoutes.delete("/business-profiles/:profileId/:sourceId", authenticateToken, authorizeBusinessProfile, async (req: Request, res: Response) => {
  try {
    const profileId = parseInt(req.params.profileId);
    const sourceId = parseInt(req.params.sourceId);

    await prisma.externalDataSource.deleteMany({
      where: { id: sourceId, businessProfileId: profileId },
    });

    return res.json({ success: true });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

export default externalDataSourceRoutes;
