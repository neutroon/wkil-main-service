import { z } from "zod";

const followUpDelaySchema = z.object({
  amount: z.coerce.number().int().min(1).max(10080),
  unit: z.enum(["MINUTES", "HOURS", "DAYS"]),
});

const customerMemoryFieldSchema = z.object({
  key: z.string().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
});

const knowledgeDocumentSchema = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "Invalid knowledge document kind"),
  title: z.string().max(200).optional(),
  content: z.string().min(1).max(20000),
});

/**
 * Settings-only profile fields (create + update)
 */
const businessProfileSettingsSchema = z.object({
  name: z.string().min(1, "Business name is required"),
  voice: z.string().min(1, "Voice description is required"),
  tone: z.string().min(1, "Tone description is required"),
  expectedUserIntents: z.array(z.string()).min(1, "At least one expected user intent is required"),
  corePolicies: z.string().optional(),
  brandLogoUrl: z.string().url("Invalid logo URL format").optional().or(z.literal("")),
  brandPrimaryColor: z.string().regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, "Invalid hex color format").optional().or(z.literal("")),
  brandSecondaryColor: z.string().regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, "Invalid hex color format").optional().or(z.literal("")),
  brandAccentColor: z.string().regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, "Invalid hex color format").optional().or(z.literal("")),
  visualAesthetic: z.string().optional(),
  artStyle: z.string().optional(),
  brandKitCompleted: z.boolean().optional().default(false),
  customerDetailsInstructions: z.string().optional(),
  customerMemoryFields: z.array(customerMemoryFieldSchema).length(3).optional(),
  aiBehaviorInstructions: z.string().max(4000, "AI behavior instructions must be 4000 characters or less").optional(),
  handoffEnabled: z.boolean().optional().default(true),
  followUpEnabled: z.boolean().optional().default(false),
  followUpMode: z.enum(["AUTO", "CUSTOM"]).optional().default("AUTO"),
  followUpDelays: z.array(followUpDelaySchema).max(5).optional().default([]),
  followUpInstructions: z.string().max(2000, "Follow-up instructions must be 2000 characters or less").optional(),
});

/**
 * Business Profile Creation Schema (settings + initial documents)
 */
export const businessProfileSchema = z.object({
  body: businessProfileSettingsSchema.extend({
    documents: z.array(knowledgeDocumentSchema).optional(),
  }),
});

/**
 * Partial update schema for existing profiles (settings-only — no documents)
 */
export const updateBusinessProfileSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
  body: businessProfileSettingsSchema.partial(),
});
