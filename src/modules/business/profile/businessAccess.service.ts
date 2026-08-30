import prisma from "@config/prisma";
import { AppError } from "@middlewares/errorHandler.middleware";
import { canManageUser } from "@modules/auth/user/user.service";
import type { BusinessProfile } from "@prisma/client";
import { businessProfileWithOwnerSelect } from "./businessProfile.select";
import { ingestProfileDocuments } from "./knowledge.service";

interface CustomerMemoryFieldInput {
  key?: string;
  label?: string;
  description?: string;
}

export interface BusinessProfileUpdateBody {
  name?: string;
  voice?: string;
  tone?: string;
  expectedUserIntents?: string[];
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

const AGENT_SETTINGS_FIELDS = [
  "voice",
  "tone",
  "handoffEnabled",
  "aiBehaviorInstructions",
  "corePolicies",
  "customerDetailsInstructions",
  "followUpEnabled",
  "followUpMode",
  "followUpInstructions",
] as const;

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
      voice: body.voice,
      tone: body.tone,
      expectedUserIntents: body.expectedUserIntents,
      corePolicies: body.corePolicies,
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
      brandLogoUrl: body.brandLogoUrl,
      brandPrimaryColor: body.brandPrimaryColor,
      brandSecondaryColor: body.brandSecondaryColor,
      brandAccentColor: body.brandAccentColor,
      visualAesthetic: body.visualAesthetic,
      artStyle: body.artStyle,
      brandKitCompleted: body.brandKitCompleted,
    },
    select: businessProfileWithOwnerSelect,
  });

  const updatedFields = Object.keys(body) as (keyof BusinessProfileUpdateBody)[];
  if (updatedFields.length > 0) {
    // RAG lives in agent-svc now — re-ingest the profile's knowledge documents.
    await ingestProfileDocuments(profileId);
  }

  return businessProfile;
}

export async function updateAgentSettingsForUser(
  userId: number,
  profileId: number | undefined,
  data: Record<string, unknown>,
): Promise<BusinessProfile> {
  const profile =
    profileId !== undefined
      ? await prisma.businessProfile.findFirst({
          where: { id: profileId, userId },
        })
      : await prisma.businessProfile.findFirst({
          where: { userId },
          orderBy: { createdAt: "asc" },
        });

  if (!profile) {
    throw new AppError("Business profile not found", 404);
  }

  const settings: Record<string, unknown> = {};
  for (const field of AGENT_SETTINGS_FIELDS) {
    if (data[field] !== undefined) {
      settings[field] = data[field];
    }
  }

  return prisma.businessProfile.update({
    where: { id: profile.id },
    data: settings,
  });
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

export async function updateBusinessProfileForOwner(
  userId: number,
  profileId: number,
  body: BusinessProfileUpdateBody,
) {
  const owned = await prisma.businessProfile.findFirst({
    where: { id: profileId, userId },
  });
  if (!owned) throw new AppError("Business profile not found", 404);
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
