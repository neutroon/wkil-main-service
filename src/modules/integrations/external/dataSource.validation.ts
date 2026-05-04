import { z } from "zod";

/**
 * Data Source Schema
 * POST /v1/external-data-sources/business-profiles/:profileId
 */
export const dataSourceSchema = z.object({
  params: z.object({
    profileId: z.coerce.number(),
  }),
  body: z.object({
    name: z.string().min(1, "Name is required"),
    description: z.string().min(1, "Description is required"),
    apiUrl: z.string().url("Invalid API URL"),
    method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().default("GET"),
    headers: z.record(z.string(), z.string()).optional(),
    queryParams: z.record(z.string(), z.string()).optional(),
    expectedParamsSchema: z.any().optional(),
    isActive: z.boolean().optional().default(true),
  }),
});

/**
 * Update Data Source Schema
 * PUT /v1/external-data-sources/business-profiles/:profileId/:sourceId
 */
export const updateDataSourceSchema = z.object({
  params: z.object({
    profileId: z.coerce.number(),
    sourceId: z.coerce.number(),
  }),
  body: z.object({
    name: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    apiUrl: z.string().url().optional(),
    method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    queryParams: z.record(z.string(), z.string()).optional(),
    expectedParamsSchema: z.any().optional(),
    isActive: z.boolean().optional(),
  }),
});

/**
 * Get Data Sources Schema
 */
export const getDataSourceSchema = z.object({
  params: z.object({
    profileId: z.coerce.number(),
  }),
});

/**
 * Delete Data Source Schema
 */
export const deleteDataSourceSchema = z.object({
  params: z.object({
    profileId: z.coerce.number(),
    sourceId: z.coerce.number(),
  }),
});
