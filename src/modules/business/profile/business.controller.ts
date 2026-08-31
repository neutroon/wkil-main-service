import { AgentClient } from "@modules/ai-agent/client/agent.client";
import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import prisma from "@config/prisma";
import { uploadToR2 } from "@modules/media/services/r2Storage.service";
import { randomUUID } from "crypto";
import path from "path";

import { AppError } from "@middlewares/errorHandler.middleware";
import { provisionWorkspaceForUser } from "@modules/workspace/workspace.service";
import { ingestProfileDocuments } from "./knowledge.service";

interface KnowledgeDocumentInput {
  kind: string;
  title?: string;
  content: string;
}

interface BusinessProfileBody {
  name: string;
  voice: string;
  tone: string;
  expectedUserIntents: string[];
  corePolicies?: string;
  brandLogoUrl?: string;
  brandPrimaryColor?: string;
  brandSecondaryColor?: string;
  brandAccentColor?: string;
  visualAesthetic?: string;
  artStyle?: string;
  brandKitCompleted?: boolean;
  customerDetailsInstructions?: string;
  customerMemoryFields?: CustomerMemoryFieldInput[];
  aiBehaviorInstructions?: string;
  handoffEnabled?: boolean;
  followUpEnabled?: boolean;
  followUpMode?: "AUTO" | "CUSTOM";
  followUpDelays?: { amount: number; unit: "MINUTES" | "HOURS" | "DAYS" }[];
  followUpInstructions?: string;
  documents?: KnowledgeDocumentInput[];
}

interface CustomerMemoryFieldInput {
  key?: string;
  label?: string;
  description?: string;
}

function normalizeCustomerMemoryFields(
  fields?: CustomerMemoryFieldInput[],
): CustomerMemoryFieldInput[] {
  return Array.from({ length: 3 }, (_, index) => {
    const field = fields?.[index] || {};
    const label = cleanProfileString(field.label);
    const description = cleanProfileString(field.description);
    const key = label
      ? cleanMemoryFieldKey(field.key) || generateMemoryFieldKey(label, index)
      : "";

    return { key, label, description };
  });
}

function cleanProfileString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanMemoryFieldKey(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function generateMemoryFieldKey(label: string, index: number): string {
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) {
    hash = (hash * 31 + label.charCodeAt(i)) | 0;
  }
  return `field_${index + 1}_${Math.abs(hash).toString(36)}`;
}

export const createBusinessProfile = async (req: Request, res: Response) => {
  const {
    name,
    voice,
    tone,
    expectedUserIntents,
    corePolicies,
    customerDetailsInstructions,
    customerMemoryFields,
    aiBehaviorInstructions,
    handoffEnabled,
    followUpEnabled,
    followUpMode,
    followUpDelays,
    followUpInstructions,
    documents,
    brandLogoUrl,
    brandPrimaryColor,
    brandSecondaryColor,
    brandAccentColor,
    visualAesthetic,
    artStyle,
    brandKitCompleted,
  }: BusinessProfileBody = req.body;

  const userId = (req as any).user.id;

  // The dashboard form completes the auto-provisioned skeleton profile
  // instead of creating a second one. BusinessProfile has no isActive
  // column — ownership scoping by userId is sufficient here.
  const existing = await prisma.businessProfile.findFirst({
    where: { userId },
    orderBy: { id: "asc" },
  });

  const profileData = {
    name: cleanProfileString(name) || "My Business",
    voice,
    tone,
    expectedUserIntents,
    corePolicies,
    customerDetailsInstructions,
    customerMemoryFields: normalizeCustomerMemoryFields(customerMemoryFields),
    aiBehaviorInstructions,
    handoffEnabled,
    followUpEnabled,
    followUpMode,
    followUpDelays,
    followUpInstructions,
    brandLogoUrl,
    brandPrimaryColor,
    brandSecondaryColor,
    brandAccentColor,
    visualAesthetic,
    artStyle,
    brandKitCompleted,
    setupCompletedAt: new Date(),
  };

  let businessProfile;
  if (existing) {
    businessProfile = await prisma.businessProfile.update({
      where: { id: existing.id },
      data: profileData,
      include: { knowledgeDocuments: true, whatsAppAccounts: true },
    });
  } else {
    // Defensive no-profile branch: provision the workspace trio (workspace +
    // skeleton profile + owner membership) so the required 1:1 workspace
    // relation is satisfied, then complete the freshly created skeleton.
    const { profileId } = await prisma.$transaction((tx) =>
      provisionWorkspaceForUser(tx as unknown as Prisma.TransactionClient, userId, profileData.name),
    );
    businessProfile = await prisma.businessProfile.update({
      where: { id: profileId },
      data: profileData,
      include: { knowledgeDocuments: true, whatsAppAccounts: true },
    });
  }

  if (documents && documents.length > 0) {
    await prisma.knowledgeDocument.createMany({
      data: documents.map((d) => ({
        businessProfileId: businessProfile.id,
        kind: d.kind,
        title: d.title ?? null,
        content: d.content,
      })),
    });
  }

  // mark user as having a business profile
  await prisma.user.update({
    where: {
      id: userId,
    },
    data: {
      isBusinessProfileCreated: true,
    },
  });

  // trigger full ingestion via AgentClient — RAG lives in agent-svc now.
  await AgentClient.ingestRag({
    business_profile_id: businessProfile.id,
    documents: await prisma.knowledgeDocument.findMany({
      where: { businessProfileId: businessProfile.id },
      select: { id: true, businessProfileId: true, kind: true, title: true, content: true },
    }),
    mode: "full",
  } as any);

  const formattedProfile = {
    ...businessProfile,
    isConnectedToMeta: false,
    socialId: null,
  };

  return res.status(201).json({
    message: "Business profile created successfully",
    businessProfile: formattedProfile,
  });
};

export const getBusinessProfiles = async (req: Request, res: Response) => {
  const userId: number = (req as any).user.id;

  // Find all profiles belonging to this user
  const businessProfiles = await prisma.businessProfile.findMany({
    where: {
      userId,
    },
    include: {
      knowledgeDocuments: true,
      whatsAppAccounts: true,
      facebookPages: {
        select: {
          pageId: true,
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return res.status(200).json({
    message: "Business profiles fetched successfully",
    businessProfiles,
  });
};

export const updateBusinessProfile = async (req: Request, res: Response) => {
  const userId: number = (req as any).user.id;
  const profileId = parseInt(req.params.id);

  const {
    name,
    voice,
    tone,
    expectedUserIntents,
    corePolicies,
    customerDetailsInstructions,
    customerMemoryFields,
    aiBehaviorInstructions,
    handoffEnabled,
    followUpEnabled,
    followUpMode,
    followUpDelays,
    followUpInstructions,
    brandLogoUrl,
    brandPrimaryColor,
    brandSecondaryColor,
    brandAccentColor,
    visualAesthetic,
    artStyle,
    brandKitCompleted,
  }: BusinessProfileBody = req.body;

  // Verify the profile exists AND belongs to this user
  const existing = await prisma.businessProfile.findFirst({
    where: { id: profileId, userId },
  });

  if (!existing) {
    throw new AppError("Business profile not found", 404);
  }

  const businessProfile = await prisma.businessProfile.update({
    where: { id: profileId },
    data: {
      name,
      voice,
      tone,
      expectedUserIntents,
      corePolicies,
      customerDetailsInstructions,
      customerMemoryFields:
        customerMemoryFields !== undefined
          ? normalizeCustomerMemoryFields(customerMemoryFields)
          : undefined,
      aiBehaviorInstructions,
      handoffEnabled,
      followUpEnabled,
      followUpMode,
      followUpDelays,
      followUpInstructions,
      brandLogoUrl,
      brandPrimaryColor,
      brandSecondaryColor,
      brandAccentColor,
      visualAesthetic,
      artStyle,
      brandKitCompleted,
    },
    include: {
      knowledgeDocuments: true,
      whatsAppAccounts: true,
      facebookPages: {
        select: {
          pageId: true,
        },
      },
    },
  });

  // re-ingest the profile's knowledge documents — RAG lives in agent-svc now.
  await ingestProfileDocuments(profileId);

  const { facebookPages = [], ...rest } = businessProfile as typeof businessProfile & {
    facebookPages?: { pageId: string }[];
  };
  const formattedProfile = {
    ...rest,
    isConnectedToMeta: facebookPages.length > 0,
    socialId: facebookPages.length > 0 ? facebookPages[0].pageId : null,
  };

  return res.status(200).json({
    message: "Business profile updated successfully",
    businessProfile: formattedProfile,
  });
};

export const deleteBusinessProfile = async (req: Request, res: Response) => {
  const userId: number = (req as any).user.id;
  const profileId = parseInt(req.params.id);

  // Verify the profile exists AND belongs to this user
  const existing = await prisma.businessProfile.findFirst({
    where: { id: profileId, userId },
  });

  if (!existing) {
    throw new AppError("Business profile not found", 404);
  }

  await prisma.businessProfile.delete({
    where: { id: profileId },
  });

  // Check if any profiles are left to keep the onboarding gate state accurate
  const profileCount = await prisma.businessProfile.count({
    where: { userId },
  });

  if (profileCount === 0) {
    await prisma.user.update({
      where: { id: userId },
      data: { isBusinessProfileCreated: false },
    });
  }

  return res.status(200).json({
    message: "Business profile deleted successfully",
  });
};

export const retrieveBusinessProfile = async (req: Request, res: Response) => {
  const { query } = req.body;
  if (!query) throw new AppError("query is required", 400);

  // Retrieval lives in agent-svc now. Surface a clear message until a
  // retrieval endpoint is exposed by the agent-svc microservice.
  res.status(503).json({
    error: "rag_retrieval_moved_to_agent_svc",
    message:
      "RAG retrieval is now handled by the agent-svc microservice; this endpoint is disabled.",
  });
  void query;
  void req;
};

export const previewBusinessProfileChat = async (req: Request, res: Response) => {
  return AgentClient.runCopilot({
    business_profile_id: Number(req.params.id),
    user_id: (req as any).user.id,
    messages: [],
    stage: "fast",
  } as any) as any;
};

export const uploadLogo = async (req: Request, res: Response) => {
  const userId = (req as any).user.id;

  if (!req.file) {
    throw new AppError("No logo file uploaded", 400);
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  const key = `logos/u_${userId}/${randomUUID()}${ext}`;

  const publicUrl = await uploadToR2(key, req.file.buffer, req.file.mimetype);

  return res.status(200).json({
    message: "Logo uploaded successfully",
    url: publicUrl,
  });
};
