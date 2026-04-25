import { z } from "zod";

const faqSchema = z.object({
  question: z.string().min(1, "Question is required"),
  answer: z.string().min(1, "Answer is required"),
});

const knowledgeSectionSchema = z.object({
  title: z.string().min(1, "Title is required"),
  content: z.string().min(1, "Content is required"),
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
    leadCaptureInstructions: z.string().optional(),
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
