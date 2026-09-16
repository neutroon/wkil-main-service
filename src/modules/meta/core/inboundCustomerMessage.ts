import { z } from "zod";

const nonEmptyId = z.string().trim().min(1).max(512);

const attachmentSchema = z.object({
  id: nonEmptyId.optional(),
  type: z.enum(["image", "video", "audio", "voice", "document", "sticker", "file"]),
  mimeType: z.string().trim().max(255).optional(),
  url: z.string().url().max(4_096).optional(),
  title: z.string().trim().max(1_024).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

const baseInboundCustomerMessageSchema = z.object({
  businessProfileId: z.number().int().positive(),
  identifier: nonEmptyId,
  senderId: nonEmptyId,
  externalId: nonEmptyId,
  text: z.string().max(12_000),
  receivedAt: z.string().datetime({ offset: true }),
  customerName: z.string().trim().max(512).optional(),
  isFromBusiness: z.boolean().optional(),
  attachments: z.array(attachmentSchema).max(10),
});

const whatsappInboundCustomerMessageSchema = baseInboundCustomerMessageSchema.extend({
  channel: z.literal("whatsapp"),
  phoneNumberId: nonEmptyId,
  customerPhone: nonEmptyId,
}).strict();

const messengerInboundCustomerMessageSchema = baseInboundCustomerMessageSchema.extend({
  channel: z.literal("messenger"),
  pageId: nonEmptyId,
}).strict();

const facebookCommentInboundCustomerMessageSchema = baseInboundCustomerMessageSchema.extend({
  channel: z.literal("facebook_comment"),
  pageId: nonEmptyId,
  commentId: nonEmptyId,
  postId: nonEmptyId,
  parentId: nonEmptyId.optional(),
  source: z.enum(["page_feed", "group_feed"]),
}).strict();

export const inboundCustomerMessageSchema = z.discriminatedUnion("channel", [
  whatsappInboundCustomerMessageSchema,
  messengerInboundCustomerMessageSchema,
  facebookCommentInboundCustomerMessageSchema,
]);

export type InboundCustomerMessage = z.infer<typeof inboundCustomerMessageSchema>;
export type InboundCustomerAttachment = z.infer<typeof attachmentSchema>;
