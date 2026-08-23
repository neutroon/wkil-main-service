import { z } from "zod";
import prisma from "@config/prisma";
import { updateBusinessProfileForOwner } from "@modules/business/profile/businessAccess.service";
import { setCopilotOnboardingStep } from "../copilot.store";
import type { CopilotToolDefinition } from "./copilotTool.types";

export const saveBusinessInfoTool: CopilotToolDefinition = {
  name: "save_business_info",
  description:
    "Save or update the owner's business core profile: name, identity, target audience, voice, tone, products/services, core policies. Call during onboarding after collecting the owner's answers.",
  schema: z.object({
    name: z.string().min(1).optional(),
    identity: z.string().optional(),
    targetAudience: z.string().optional(),
    voice: z.string().optional(),
    tone: z.string().optional(),
    productsServices: z.array(z.string()).optional(),
    corePolicies: z.string().optional(),
  }),
  requiresConfirmation: false,
  handler: async (args, ctx) => {
    let profile = await prisma.businessProfile.findFirst({
      where: { userId: ctx.userId },
    });
    if (!profile) {
      profile = await prisma.businessProfile.create({
        data: {
          userId: ctx.userId,
          name: args.name ?? "My Business",
          identity: args.identity ?? "",
          targetAudience: args.targetAudience ?? "",
          productsServices: args.productsServices ?? [],
          expectedUserIntents: [],
          phoneNumbers: [],
        },
      });
    }
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (v !== undefined) body[k] = v;
    }
    const updated = await updateBusinessProfileForOwner(ctx.userId, profile.id, body);
    await setCopilotOnboardingStep(ctx.conversationId, "website_scrape");
    return { profileId: updated.id, advanced: "website_scrape" };
  },
};
