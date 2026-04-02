import { Router } from "express";
import { authenticateToken } from "../middlewares/auth.middleware";
import prisma from "../config/prisma";
import { Request, Response } from "express";

const crmRoutes = Router();

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

// Get all integrations for a profile
crmRoutes.get("/business-profiles/:profileId", authenticateToken, authorizeBusinessProfile, async (req: Request, res: Response) => {
  try {
    const profileId = parseInt(req.params.profileId);
    const integrations = await prisma.crmIntegration.findMany({
      where: { businessProfileId: profileId },
    });
    return res.json(integrations);
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

// Configure or update an external CRM integration (Webhook/SaaS)
crmRoutes.post("/business-profiles/:profileId", authenticateToken, authorizeBusinessProfile, async (req: Request, res: Response) => {
  try {
    const profileId = parseInt(req.params.profileId);
    const { provider, webhookUrl, apiKey } = req.body;

    if (!provider) {
        return res.status(400).json({ error: "Provider (e.g. 'webhook') is required" });
    }

    // Upsert a single CRM integration per provider type
    const integration = await prisma.crmIntegration.upsert({
      where: {
        id: await prisma.crmIntegration.findFirst({
            where: { businessProfileId: profileId, provider }
        }).then((result: any) => result?.id || 0)
      },
      update: {
        webhookUrl,
        apiKey,
        isActive: true,
      },
      create: {
        businessProfileId: profileId,
        provider,
        webhookUrl,
        apiKey,
        isActive: true,
      }
    });

    return res.json({ success: true, integration });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

// Delete an external CRM integration
crmRoutes.delete("/business-profiles/:profileId/:integrationId", authenticateToken, authorizeBusinessProfile, async (req: Request, res: Response) => {
  try {
    const profileId = parseInt(req.params.profileId);
    const integrationId = parseInt(req.params.integrationId);

    await prisma.crmIntegration.deleteMany({
      where: { id: integrationId, businessProfileId: profileId },
    });

    return res.json({ success: true });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

export default crmRoutes;
