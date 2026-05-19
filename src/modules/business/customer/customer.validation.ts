import { z } from "zod";

export const listCustomersSchema = z.object({
  query: z.object({
    businessProfileId: z.coerce.number().optional(),
    q: z.string().optional(),
    hasPhone: z.coerce.boolean().optional(),
    status: z.string().optional(),
    channel: z.string().optional(),
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  }),
});

export const customerIdSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
});

export const updateCustomerSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
  }),
  body: z.object({
    displayName: z.string().min(1).optional(),
    phone: z.string().nullable().optional(),
    email: z.string().email().nullable().optional(),
    status: z.string().min(1).optional(),
    notes: z.string().nullable().optional(),
    capturedFieldUpdates: z
      .record(
        z.string().min(1),
        z.union([z.string(), z.number(), z.boolean(), z.null()]),
      )
      .optional(),
  }),
});
