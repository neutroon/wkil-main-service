import { z } from "zod";

/**
 * Schema for sending a Messenger reply
 * POST /v1/messenger/conversations/:id/messages
 */
export const sendMessengerReplySchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
  body: z.object({
    message: z.string().min(1, "Message is required").max(2000),
    type: z.enum(["text", "image", "file"]).optional().default("text"),
    attachmentId: z.string().optional(),
  }),
});

/**
 * Schema for sending a WhatsApp reply
 * POST /v1/whatsapp/conversations/:id/messages
 */
export const sendWhatsAppReplySchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
  body: z.object({
    message: z.string().min(1, "Message is required").max(4000),
    type: z.enum(["text", "image", "document", "template"]).optional().default("text"),
    templateName: z.string().optional(),
  }),
});

/**
 * Schema for sending a WhatsApp template
 * POST /v1/whatsapp/conversations/:id/template
 */
export const sendWhatsAppTemplateSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
  body: z.object({
    templateName: z.string().min(1, "Template name is required"),
    languageCode: z.string().min(2, "Language code is required (e.g., en_US)"),
    components: z.array(z.any()).optional().default([]),
    textPreview: z.string().optional(),
  }),
});
