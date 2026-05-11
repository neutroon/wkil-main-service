import { Request, Response } from "express";
import prisma from "@config/prisma";
import {
  ingestBusinessProfile,
  partialReIngestBusinessProfile,
  retrieveRelevantChunks,
} from "../../ai-agent/rag/rag.service";
import { uploadToR2 } from "@modules/media/services/r2Storage.service";
import { randomUUID } from "crypto";
import path from "path";
import { computeBusinessChatReply } from "@modules/ai-agent/chat/businessChatReply.service";
import { resolveAssetForChannel } from "@modules/media/services/mediaLibrary.service";

import { AppError } from "@middlewares/errorHandler.middleware";

interface Faq {
  id?: number;
  question: string;
  answer: string;
}

interface KnowledgeSection {
  id?: number;
  title: string;
  content: string;
}

interface BusinessProfileBody {
  name: string;
  identity: string;
  targetAudience: string;
  voice: string;
  tone: string;
  productsServices: string[];
  expectedUserIntents: string[];
  corePolicies?: string;
  phoneNumbers: string[];
  workingHours?: string;
  address?: string;
  faqs?: Faq[];
  knowledgeSections?: KnowledgeSection[];
  brandLogoUrl?: string;
  brandPrimaryColor?: string;
  brandSecondaryColor?: string;
  brandAccentColor?: string;
  visualAesthetic?: string;
  artStyle?: string;
  brandKitCompleted?: boolean;
  brandWatermarkEnabled?: boolean;
  watermarkPosition?: "TOP_LEFT" | "TOP_RIGHT" | "BOTTOM_LEFT" | "BOTTOM_RIGHT" | "CENTER";
  customerDetailsInstructions?: string;
  customerMemoryFields?: CustomerMemoryFieldInput[];
  aiBehaviorInstructions?: string;
  followUpEnabled?: boolean;
  followUpMode?: "AUTO" | "CUSTOM";
  followUpDelays?: { amount: number; unit: "MINUTES" | "HOURS" | "DAYS" }[];
  followUpInstructions?: string;
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
    identity,
    targetAudience,
    voice,
    tone,
    productsServices,
    expectedUserIntents,
    corePolicies,
    phoneNumbers,
    workingHours,
    address,
    faqs,
    knowledgeSections,
    customerDetailsInstructions,
    customerMemoryFields,
    aiBehaviorInstructions,
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
    brandWatermarkEnabled,
    watermarkPosition,
  }: BusinessProfileBody = req.body;

  const userId = (req as any).user.id;

  const businessProfile = await prisma.businessProfile.create({
    data: {
      userId,
      name,
      identity,
      targetAudience,
      voice,
      tone,
      productsServices,
      expectedUserIntents,
      corePolicies,
      phoneNumbers,
      workingHours,
      address,
      customerDetailsInstructions,
      customerMemoryFields: normalizeCustomerMemoryFields(customerMemoryFields),
      aiBehaviorInstructions,
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
      brandWatermarkEnabled,
      watermarkPosition,
      ...(faqs &&
        faqs.length > 0 && {
          faqs: {
            create: faqs.map((faq) => ({
              question: faq.question,
              answer: faq.answer,
            })),
          },
        }),
      ...(knowledgeSections &&
        knowledgeSections.length > 0 && {
          knowledgeSections: {
            create: knowledgeSections.map((ks) => ({
              title: ks.title,
              content: ks.content,
            })),
          },
        }),
    },
    include: {
      faqs: true,
      knowledgeSections: true,
      whatsAppAccounts: true,
    },
  });

  // mark user as having a business profile
  await prisma.user.update({
    where: {
      id: userId,
    },
    data: {
      isBusinessProfileCreated: true,
    },
  });

  // trigger full ingestion
  await ingestBusinessProfile(businessProfile.id);

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
      faqs: true,
      knowledgeSections: true,
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
    identity,
    targetAudience,
    voice,
    tone,
    productsServices,
    expectedUserIntents,
    corePolicies,
    phoneNumbers,
    workingHours,
    address,
    faqs,
    knowledgeSections,
    customerDetailsInstructions,
    customerMemoryFields,
    aiBehaviorInstructions,
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
    brandWatermarkEnabled,
    watermarkPosition,
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
      identity,
      targetAudience,
      voice,
      tone,
      productsServices,
      expectedUserIntents,
      corePolicies,
      phoneNumbers,
      workingHours,
      address,
      customerDetailsInstructions,
      customerMemoryFields:
        customerMemoryFields !== undefined
          ? normalizeCustomerMemoryFields(customerMemoryFields)
          : undefined,
      aiBehaviorInstructions,
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
      brandWatermarkEnabled,
      watermarkPosition,
      // Delete existing FAQs and recreate — avoids needing IDs in the payload
      ...(faqs && {
        faqs: {
          deleteMany: {},
          create: faqs.map((faq) => ({
            question: faq.question,
            answer: faq.answer,
          })),
        },
      }),
      ...(knowledgeSections && {
        knowledgeSections: {
          deleteMany: {},
          create: knowledgeSections.map((ks) => ({
            title: ks.title,
            content: ks.content,
          })),
        },
      }),
    },
    include: {
      faqs: true,
      knowledgeSections: true,
      whatsAppAccounts: true,
      facebookPages: {
        select: {
          pageId: true,
        },
      },
    },
  });

  // trigger partial re-ingestion - only re-embeds what changed
  const updatedFields = Object.keys(
    req.body as BusinessProfileBody,
  ) as (keyof BusinessProfileBody)[];
  await partialReIngestBusinessProfile(profileId, updatedFields);

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

  const chunks = await retrieveRelevantChunks(Number(req.params.id), query);
  res.json({ chunks });
};

export const previewBusinessProfileChat = async (req: Request, res: Response) => {
  const userId: number = (req as any).user.id;
  const profileId = Number(req.params.id);
  const message = String(req.body?.message ?? "")
    .replace(/[\uFE00-\uFE0F\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!message) throw new AppError("message is required", 400);
  if (message.length > 4000) throw new AppError("message is too long", 400);

  const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];
  const historyTurns = rawHistory
    .slice(-20)
    .filter(
      (turn: any) =>
        (turn?.role === "user" || turn?.role === "model") &&
        typeof turn?.content === "string" &&
        turn.content.trim().length > 0,
    )
    .map((turn: any) => ({
      role: turn.role as "user" | "model",
      text: String(turn.content).slice(0, 2000),
    }));

  const businessProfile = await prisma.businessProfile.findFirst({
    where: { id: profileId, userId },
    include: {
      externalDataSources: { where: { isActive: true } },
    },
  });

  if (!businessProfile) {
    throw new AppError("Business profile not found", 404);
  }

  if (req.body?.stream === true) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    try {
      res.write(`data: ${JSON.stringify({ status: "processing" })}\n\n`);

      const finalDecision = await computeBusinessChatReply({
        businessProfile,
        messageText: message,
        historyTurns,
        channel: "web",
        responseMode: "AUTO",
      });

      let attachment = null;
      if (finalDecision?.attachment?.assetName) {
        const resolved = await resolveAssetForChannel(
          finalDecision.attachment.assetName,
          businessProfile.id,
          "web",
        );
        if (resolved?.url) {
          attachment = {
            url: resolved.url,
            type: resolved.mediaType,
            caption: finalDecision.attachment.caption ?? null,
          };
        }
      }

      res.write(
        `data: ${JSON.stringify({
          final: {
            reply: finalDecision?.content || "",
            action: finalDecision?.action || "REPLY_AUTO",
            reasoning: finalDecision?.reasoning || "",
            handoffCategory: finalDecision?.handoffCategory ?? null,
            attachment,
            preview: true,
          },
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    } catch (err) {
      res.write(
        `data: ${JSON.stringify({
          error: err instanceof Error ? err.message : "Preview failed.",
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
  }

  const decision = await computeBusinessChatReply({
    businessProfile,
    messageText: message,
    historyTurns,
    channel: "web",
    responseMode: "AUTO",
  });

  let attachment = null;
  if (decision.attachment?.assetName) {
    const resolved = await resolveAssetForChannel(
      decision.attachment.assetName,
      businessProfile.id,
      "web",
    );
    if (resolved?.url) {
      attachment = {
        url: resolved.url,
        type: resolved.mediaType,
        caption: decision.attachment.caption ?? null,
      };
    }
  }

  return res.json({
    reply: decision.content || "",
    action: decision.action,
    reasoning: decision.reasoning,
    handoffCategory: decision.handoffCategory ?? null,
    attachment,
    preview: true,
  });
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






