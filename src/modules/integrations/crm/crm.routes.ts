import { Router, Request, Response, NextFunction } from "express";
import { authenticateToken } from "@modules/auth/core/auth.middleware";
import prisma from "@config/prisma";
import { validate } from "@middlewares/validate.middleware";
import { crmIntegrationSchema, getCrmSchema, deleteCrmSchema } from "./crm.validation";
import { AppError } from "@middlewares/errorHandler.middleware";
import { encryptFacebookSecret } from "@modules/auth/core/tokenCrypto";

const crmRoutes = Router();
const MASKED_SECRET = "********";

function serializeCrmIntegration<T extends { apiKey?: string | null }>(
  integration: T,
): T {
  return {
    ...integration,
    apiKey: integration.apiKey ? MASKED_SECRET : null,
  };
}

function resolveApiKeyUpdate(
  existingApiKey: string | null | undefined,
  incomingApiKey: string | undefined,
): string | undefined {
  if (incomingApiKey === undefined) return undefined;
  if (incomingApiKey === MASKED_SECRET) return existingApiKey || undefined;
  if (incomingApiKey.trim() === "") return undefined;
  return encryptFacebookSecret(incomingApiKey);
}

// Middleware to ensure user owns the business profile
const authorizeBusinessProfile = async (req: Request, res: Response, next: NextFunction) => {
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

// Get all integrations for a profile
crmRoutes.get(
  "/business-profiles/:profileId", 
  authenticateToken, 
  validate(getCrmSchema),
  authorizeBusinessProfile, 
  async (req: Request, res: Response) => {
    const profileId = parseInt(req.params.profileId);
    const integrations = await prisma.crmIntegration.findMany({
      where: { businessProfileId: profileId },
    });
    return res.json(integrations.map(serializeCrmIntegration));
  }
);

// Configure or update an external CRM integration (Webhook/SaaS)
crmRoutes.post(
  "/business-profiles/:profileId", 
  authenticateToken, 
  validate(crmIntegrationSchema),
  authorizeBusinessProfile, 
  async (req: Request, res: Response) => {
    const profileId = parseInt(req.params.profileId);
    const { provider, webhookUrl, apiKey, fieldMapping } = req.body;

    // Find existing integration to get its ID for upsert
    const existing = await prisma.crmIntegration.findFirst({
      where: { businessProfileId: profileId, provider }
    });

    const integration = await prisma.crmIntegration.upsert({
      where: {
        id: existing?.id || 0
      },
      update: {
        webhookUrl,
        apiKey: resolveApiKeyUpdate(existing?.apiKey, apiKey),
        fieldMapping,
        isActive: true,
      },
      create: {
        businessProfileId: profileId,
        provider,
        webhookUrl,
        apiKey: apiKey ? encryptFacebookSecret(apiKey) : undefined,
        fieldMapping,
        isActive: true,
      }
    });

    return res.json({
      success: true,
      integration: serializeCrmIntegration(integration),
    });
  }
);

// Delete an external CRM integration
crmRoutes.delete(
  "/business-profiles/:profileId/:integrationId", 
  authenticateToken, 
  validate(deleteCrmSchema),
  authorizeBusinessProfile, 
  async (req: Request, res: Response) => {
    const profileId = parseInt(req.params.profileId);
    const integrationId = parseInt(req.params.integrationId);

    await prisma.crmIntegration.deleteMany({
      where: { id: integrationId, businessProfileId: profileId },
    });

    return res.json({ success: true });
  }
);

export default crmRoutes;






