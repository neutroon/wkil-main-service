import { z } from "zod";

// Canonical customer status values. The four-token enum the
// `customers` page exposes to both web and mobile clients.
export const CUSTOMER_STATUSES = [
  "ACTIVE",
  "NEEDS_FOLLOW_UP",
  "RESOLVED",
  "ARCHIVED",
] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

// Special token values used only on the list endpoint's `status`
// query param. They map to computed filters (not stored values).
export const CUSTOMER_STATUS_FILTERS = [
  ...CUSTOMER_STATUSES,
  "captured", // computed: customer has any capturedFields
  "handoff", // computed: last message has handoffCategory
  "needs-follow-up", // computed: stored status === NEEDS_FOLLOW_UP
  "all", // sentinel: no status filter
] as const;
export type CustomerStatusFilter = (typeof CUSTOMER_STATUS_FILTERS)[number];

export const listCustomersSchema = z.object({
  query: z.object({
    businessProfileId: z.coerce.number().optional(),
    q: z.string().optional(),
    hasPhone: z.coerce.boolean().optional(),
    status: z.enum(CUSTOMER_STATUS_FILTERS).optional(),
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
    status: z.enum(CUSTOMER_STATUSES).optional(),
    notes: z.string().nullable().optional(),
    capturedFieldUpdates: z
      .record(
        z.string().min(1),
        z.union([z.string(), z.number(), z.boolean(), z.null()]),
      )
      .optional(),
  }),
});
