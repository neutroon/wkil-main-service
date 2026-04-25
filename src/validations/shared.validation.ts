import { z } from "zod";

/**
 * PRODUCTION-GRADE: Shared Pagination Schema
 * Handles string-to-number transformation, defaults, and bounds enforcement.
 */
export const paginationSchema = z.object({
  query: z.object({
    page: z
      .string()
      .optional()
      .transform((val) => Math.max(1, parseInt(val || "1", 10) || 1)),
    limit: z
      .string()
      .optional()
      .transform((val) => Math.min(100, Math.max(1, parseInt(val || "20", 10) || 20))),
    cursor: z.coerce.number().optional(),
    channel: z.string().optional(),
  }),
});

/**
 * Standard ID Parameter Schema
 * Ensures :id is a numeric string and transforms it to a Number.
 */
export const idParamSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
});

/**
 * Combined Schema for ID + Pagination
 */
export const idPaginationSchema = z.object({
  params: z.object({
    id: z.coerce.number(),
  }),
  query: z.object({
    page: z
      .string()
      .optional()
      .transform((val) => Math.max(1, parseInt(val || "1", 10) || 1)),
    limit: z
      .string()
      .optional()
      .transform((val) => Math.min(100, Math.max(1, parseInt(val || "20", 10) || 20))),
    cursor: z.coerce.number().optional(),
  }),
});
