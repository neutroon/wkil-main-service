import { z } from "zod";

/**
 * OpenAI strict-mode compatible schema used by the content brief audit
 * competitor-discovery step (`content_brief` pipeline in the admin
 * pipeline registry).
 */
export const competitorDiscoverySchema = z.object({
  competitors: z.array(
    z.object({
      name: z.string(),
      url: z.string(),
      reason: z.string(),
    }),
  ),
});

export type CompetitorDiscoveryResult = z.infer<typeof competitorDiscoverySchema>;
