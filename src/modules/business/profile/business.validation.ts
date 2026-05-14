import { z } from "zod";

const faqSchema = z.object({
  question: z.string().min(1, "Question is required"),
  answer: z.string().min(1, "Answer is required"),
});

const knowledgeSectionSchema = z.object({
  title: z.string().min(1, "Title is required"),
  content: z.string().min(1, "Content is required"),
});

const followUpDelaySchema = z.object({
  amount: z.coerce.number().int().min(1).max(10080),
  unit: z.enum(["MINUTES", "HOURS", "DAYS"]),
});

const customerMemoryFieldSchema = z.object({
  key: z.string().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
});

/**
 * Business Profile Creation/Update Schema
 */
export const businessProfileSchema = z.object({
  body: z.object({
    name: z.string().min(1, "Business name is required"),
    identity: z.string().min(1, "Brand identity is required"),
    targetAudience: z.string().min(1, "Target audience is required"),
    voice: z.string().min(1, "Voice description is required"),
    tone: z.string().min(1, "Tone description is required"),
    productsServices: z.array(z.string()).min(1, "At least one product/service is required"),
    expectedUserIntents: z.array(z.string()).min(1, "At least one expected user intent is required"),
    corePolicies: z.string().optional(),
    phoneNumbers: z.array(z.string()).optional().default([]),
    workingHours: z.string().optional(),
    address: z.string().optional(),
    faqs: z.array(faqSchema).optional().default([]),
    knowledgeSections: z.array(knowledgeSectionSchema).optional().default([]),
    brandLogoUrl: z.string().url("Invalid logo URL format").optional().or(z.literal("")),
    brandPrimaryColor: z.string().regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, "Invalid hex color format").optional().or(z.literal("")),
    brandSecondaryColor: z.string().regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, "Invalid hex color format").optional().or(z.literal("")),
    brandAccentColor: z.string().regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, "Invalid hex color format").optional().or(z.literal("")),
    visualAesthetic: z.string().optional(),
    artStyle: z.string().optional(),
    brandKitCompleted: z.boolean().optional().default(false),
    brandWatermarkEnabled: z.boolean().optional().default(false),
    watermarkPosition: z.enum(["TOP_LEFT", "TOP_RIGHT", "BOTTOM_LEFT", "BOTTOM_RIGHT", "CENTER"]).optional().default("BOTTOM_RIGHT"),
    customerDetailsInstructions: z.string().optional(),
    customerMemoryFields: z.array(customerMemoryFieldSchema).length(3).optional(),
    aiBehaviorInstructions: z.string().max(4000, "AI behavior instructions must be 4000 characters or less").optional(),
    handoffEnabled: z.boolean().optional().default(true),
    followUpEnabled: z.boolean().optional().default(false),
    followUpMode: z.enum(["AUTO", "CUSTOM"]).optional().default("AUTO"),
    followUpDelays: z.array(followUpDelaySchema).max(5).optional().default([]),
    followUpInstructions: z.string().max(2000, "Follow-up instructions must be 2000 characters or less").optional(),
  }),
});

/**
 * Partial update schema for existing profiles
 */
export const updateBusinessProfileSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
  body: businessProfileSchema.shape.body.partial(),
});
