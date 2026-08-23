import { z } from "zod";
import prisma from "@config/prisma";
import { updateBusinessProfileForOwner } from "@modules/business/profile/businessAccess.service";
import { setCopilotOnboardingStep } from "../copilot.store";
import type { CopilotToolDefinition } from "./copilotTool.types";

const HEX = /^#[0-9a-fA-F]{6}$/;

export const setBrandKitTool: CopilotToolDefinition = {
  name: "set_brand_kit",
  description:
    "Set brand colors and aesthetic. Called during onboarding after the owner chooses their brand kit.",
  schema: z.object({
    brandPrimaryColor: z.string().regex(HEX).optional(),
    brandSecondaryColor: z.string().regex(HEX).optional(),
    brandAccentColor: z.string().regex(HEX).optional(),
    visualAesthetic: z.string().optional(),
    artStyle: z.string().optional(),
  }),
  requiresConfirmation: false,
  handler: async (args, ctx) => {
    const profile = await prisma.businessProfile.findFirst({
      where: { userId: ctx.userId },
    });
    if (!profile) {
      throw new Error("Business profile not found — complete save_business_info first");
    }
    const updated = await updateBusinessProfileForOwner(ctx.userId, profile.id, args);
    await setCopilotOnboardingStep(ctx.conversationId, "channel_connect");
    return { profileId: updated.id, advanced: "channel_connect" };
  },
};
