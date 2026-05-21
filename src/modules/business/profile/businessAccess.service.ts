import prisma from "@config/prisma";
import { AppError } from "@middlewares/errorHandler.middleware";
import { canManageUser } from "@modules/auth/user/user.service";
import { partialReIngestBusinessProfile } from "../../ai-agent/rag/rag.service";
import { businessProfileWithOwnerSelect } from "./businessProfile.select";

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

interface CustomerMemoryFieldInput {
  key?: string;
  label?: string;
  description?: string;
}

export interface BusinessProfileUpdateBody {
  name?: string;
  identity?: string;
  targetAudience?: string;
  voice?: string;
  tone?: string;
  productsServices?: string[];
  expectedUserIntents?: string[];
  corePolicies?: string;
  phoneNumbers?: string[];
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
  handoffEnabled?: boolean;
  followUpEnabled?: boolean;
  followUpMode?: "AUTO" | "CUSTOM";
  followUpDelays?: { amount: number; unit: "MINUTES" | "HOURS" | "DAYS" }[];
  followUpInstructions?: string;
  scrapedWebsiteUrl?: string;
  scrapedMarkdown?: string;
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

async function getProfileOwnerId(profileId: number): Promise<number> {
  if (!Number.isFinite(profileId)) {
    throw new AppError("Invalid business profile id", 400);
  }

  const profile = await prisma.businessProfile.findUnique({
    where: { id: profileId },
    select: { userId: true },
  });

  if (!profile) {
    throw new AppError("Business profile not found", 404);
  }

  return profile.userId;
}

async function assertManagerCanAccessProfile(
  managerId: number,
  profileId: number,
) {
  const ownerId = await getProfileOwnerId(profileId);
  const canAccess = await canManageUser(managerId, ownerId);

  if (!canAccess) {
    throw new AppError("You can only access profiles for users assigned to you", 403);
  }
}

async function updateBusinessProfileRecord(
  profileId: number,
  body: BusinessProfileUpdateBody,
) {
  const businessProfile = await prisma.businessProfile.update({
    where: { id: profileId },
    data: {
      name: body.name,
      identity: body.identity,
      targetAudience: body.targetAudience,
      voice: body.voice,
      tone: body.tone,
      productsServices: body.productsServices,
      expectedUserIntents: body.expectedUserIntents,
      corePolicies: body.corePolicies,
      phoneNumbers: body.phoneNumbers,
      workingHours: body.workingHours,
      address: body.address,
      customerDetailsInstructions: body.customerDetailsInstructions,
      customerMemoryFields:
        body.customerMemoryFields !== undefined
          ? normalizeCustomerMemoryFields(body.customerMemoryFields)
          : undefined,
      aiBehaviorInstructions: body.aiBehaviorInstructions,
      handoffEnabled: body.handoffEnabled,
      followUpEnabled: body.followUpEnabled,
      followUpMode: body.followUpMode,
      followUpDelays: body.followUpDelays,
      followUpInstructions: body.followUpInstructions,
      scrapedWebsiteUrl: body.scrapedWebsiteUrl,
      scrapedMarkdown: body.scrapedMarkdown,
      brandLogoUrl: body.brandLogoUrl,
      brandPrimaryColor: body.brandPrimaryColor,
      brandSecondaryColor: body.brandSecondaryColor,
      brandAccentColor: body.brandAccentColor,
      visualAesthetic: body.visualAesthetic,
      artStyle: body.artStyle,
      brandKitCompleted: body.brandKitCompleted,
      brandWatermarkEnabled: body.brandWatermarkEnabled,
      watermarkPosition: body.watermarkPosition,
      ...(body.faqs && {
        faqs: {
          deleteMany: {},
          create: body.faqs.map((faq) => ({
            question: faq.question,
            answer: faq.answer,
          })),
        },
      }),
      ...(body.knowledgeSections && {
        knowledgeSections: {
          deleteMany: {},
          create: body.knowledgeSections.map((section) => ({
            title: section.title,
            content: section.content,
          })),
        },
      }),
    },
    select: businessProfileWithOwnerSelect,
  });

  const updatedFields = Object.keys(body) as (keyof BusinessProfileUpdateBody)[];
  if (updatedFields.length > 0) {
    await partialReIngestBusinessProfile(profileId, updatedFields);
  }

  return businessProfile;
}

export async function getBusinessProfileForAdmin(profileId: number) {
  await getProfileOwnerId(profileId);

  return prisma.businessProfile.findUnique({
    where: { id: profileId },
    select: businessProfileWithOwnerSelect,
  });
}

export async function updateBusinessProfileForAdmin(
  profileId: number,
  body: BusinessProfileUpdateBody,
) {
  await getProfileOwnerId(profileId);
  return updateBusinessProfileRecord(profileId, body);
}

export async function getBusinessProfileForManagedUser(
  managerId: number,
  profileId: number,
) {
  await assertManagerCanAccessProfile(managerId, profileId);

  return prisma.businessProfile.findUnique({
    where: { id: profileId },
    select: businessProfileWithOwnerSelect,
  });
}

export async function updateBusinessProfileForManagedUser(
  managerId: number,
  profileId: number,
  body: BusinessProfileUpdateBody,
) {
  await assertManagerCanAccessProfile(managerId, profileId);
  return updateBusinessProfileRecord(profileId, body);
}
