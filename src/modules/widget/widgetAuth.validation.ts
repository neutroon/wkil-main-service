import { z } from "zod";

const hexColor = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, "Must be a valid hex color (e.g. #132322)");

/**
 * Widget Settings Schema — per-install visual customization.
 * All fields optional; null/missing = fall back to BusinessProfile brand kit.
 */
export const widgetSettingsSchema = z
  .object({
    position: z.enum(["bottom-right", "bottom-left"]).optional(),
    colors: z
      .object({
        primary: hexColor.optional(),
        secondary: hexColor.optional(),
        accent: hexColor.optional(),
      })
      .optional(),
    logoUrl: z.string().url().nullable().optional(),
    headerTitle: z.string().max(80).nullable().optional(),
    headerSubtitle: z.string().max(120).nullable().optional(),
    welcomeMessage: z.string().max(300).nullable().optional(),
    launcherStyle: z.enum(["round", "rounded", "square"]).optional(),
    greetingDelayMs: z.number().int().min(0).max(30000).optional(),
  })
  .strict();

/**
 * Widget Installation Schema
 * POST /v1/widget/installs
 */
export const widgetInstallSchema = z.object({
  body: z.object({
    businessProfileId: z.number().int().positive("Invalid businessProfileId"),
    allowedOrigins: z.union([z.string(), z.array(z.string())]).optional(),
    settings: widgetSettingsSchema.optional(),
  }),
});

/**
 * Update Widget Installation Schema
 * PATCH /v1/widget/installs/:id
 */
export const updateWidgetInstallSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
  body: z.object({
    businessProfileId: z.number().int().positive("Invalid businessProfileId").optional(),
    allowedOrigins: z.union([z.string(), z.array(z.string())]).optional(),
    isActive: z.boolean().optional(),
    settings: widgetSettingsSchema.nullable().optional(),
  }),
});

/**
 * Widget Conversation Query Schema
 * GET /v1/widget/conversations
 */
export const widgetConversationQuerySchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).optional().default("1"),
    limit: z.string().regex(/^\d+$/).optional().default("20"),
    status: z.string().optional(),
  }),
});

/**
 * Approve AI Draft Schema
 * PUT /v1/widget/conversations/:id/messages/:mid/approve
 */
export const approveDraftSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
    mid: z.coerce.number(),
  }),
  body: z.object({
    editedContent: z.string().optional(),
  }),
});

/**
 * Send Widget Reply Schema
 * POST /v1/widget/conversations/:id/messages
 */
export const widgetReplySchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
  body: z.object({
    text: z.string().min(1, "text is required").max(4000),
  }),
});

/**
 * Generic Widget ID Schema
 */
export const widgetIdParamSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
});
