import { generateVisualContent, generateContent } from "../../config/gemini";
import { createMediaAsset } from "./mediaLibrary.service";
import { recordAiUsage, assertQuotaAvailable } from "../billing.service";
import { logger } from "../../utils/logger";
import prisma from "../../config/prisma";

import axios from "axios";

/**
 * Aesthetic DNA Mappings (The Vibe)
 */
const AESTHETIC_MAPPINGS: Record<string, string> = {
  BOLD_MODERN: "strong typography, editorial feel, bold modern aesthetics",
  EGYPTIAN_STREET: "High saturation, loud colors, Arabic bold typography, busy layouts, Egyptian street aesthetic",
  KHALEEJI_LUXURY: "Gold, cream, black — opulent feel, Arabic calligraphy touches, Khaleeji luxury style",
  RAMADAN_OCCASIONS: "Crescent/lantern motifs, deep teal/gold palette, festive Arabic type, Ramadan atmosphere",
  CAIRO_MODERN: "Balances Arabic and Latin, warm earth tones, contemporary feel, modern Cairo vibe",
  ISLAMIC_GEOMETRIC: "Intricate pattern backgrounds, symmetrical layouts, rich jewel tones, Islamic geometric art",
  PHARAONIC_HERITAGE: "Sandy golds, hieroglyphic-inspired borders, deep terracotta, Pharaonic heritage theme",
  MENA_TECH: "Flat design, gradients, bilingual layout, clean, MENA startup tech aesthetic",
};

/**
 * Art Style Mappings (The Rendering)
 */
const ART_STYLE_MAPPINGS: Record<string, string> = {
  REALISTIC: "photorealistic, DSLR quality, natural lighting",
  CARTOON_3D: "3D rendered cartoon characters, Pixar-style, smooth shading",
  FLAT_ILLUSTRATION: "flat design illustration, minimal shading, vector art style",
  ANIME: "anime art style, cel shaded, vibrant",
  WATERCOLOR: "watercolor painting style, soft edges, artistic",
  ARABIC_CALLIGRAPHY: "Arabic calligraphy as decorative art element, hand-drawn feel",
  CINEMATIC: "cinematic lighting, movie poster style, dramatic",
  COMIC_POP: "comic book style, bold outlines, halftone dots, pop art",
  MINIMAL_LINE: "minimal line art illustration, single color lines, clean",
  ISOMETRIC_3D: "isometric 3D illustration, clean geometric, pastel colors",
};

/**
 * Service to handle end-to-end Gemini 3.1 Flash Image generation and editing.
 */
export async function createGeminiVisual(params: {
  userId: number;
  businessProfileId: number;
  userPrompt: string;
  postId?: number; // Optional: Link to a content plan post
}) {
  const { userId, businessProfileId, userPrompt, postId } = params;

  // 1. Fetch Business Profile and Brand Kit
  const profile = await prisma.businessProfile.findFirst({
    where: { id: businessProfileId, userId },
  });

  if (!profile) throw new Error("Business profile not found");

  // 2. Pre-flight quota check
  await assertQuotaAvailable(userId, businessProfileId);

  // 3. Assemble Brand Tokens
  const aestheticBrief = profile.visualAesthetic ? AESTHETIC_MAPPINGS[profile.visualAesthetic] || "" : "";
  const styleBrief = profile.artStyle ? ART_STYLE_MAPPINGS[profile.artStyle] || "" : "";
  const colorBrief = [profile.brandPrimaryColor, profile.brandSecondaryColor, profile.brandAccentColor]
    .filter(Boolean)
    .join(", ");

  // 4. "Art Director" - Use Gemini to beautify the prompt with brand grounding
  const artDirectorPrompt = `You are a world-class Social Media Art Director.
Convert the following user intent into a high-fidelity photographic prompt for gemini-3.1-flash-image.

[BRAND GROUNDING]:
- Aesthetic Vibe: ${aestheticBrief || "Modern and Professional"}
- Technical Style: ${styleBrief || "High-quality photography"}
- Color Palette: ${colorBrief || "Natural and vibrant"}

[CRITICAL INSTRUCTIONS]:
1. Style: Focus on "Deep Professional Photography", cinematic lighting, and 8k resolution.
2. Composition: Modern, centered, and optimized for social media engagement.
3. Native Branding: If a logo is attached, integrate it naturally into the scene or as a high-fidelity mark in the ${profile.watermarkPosition || "BOTTOM_RIGHT"} corner.
4. Prompt Intent: ${userPrompt}
5. Output: Return ONLY the final prompt string. No conversational filler.`;

  const { text: enhancedPrompt } = await generateContent(artDirectorPrompt);
  const finalPrompt = (enhancedPrompt || userPrompt).trim();

  logger.info("gemini_visual.generating_branded", { userId, businessProfileId, finalPrompt });

  // 5. Fetch Brand Logo for Multimodal injection
  let brandLogoBuffer: Buffer | undefined;
  if (profile.brandLogoUrl) {
    try {
      const resp = await axios.get(profile.brandLogoUrl, { responseType: "arraybuffer" });
      brandLogoBuffer = Buffer.from(resp.data);
    } catch (err) {
      logger.warn("gemini_visual.logo_fetch_failed", { url: profile.brandLogoUrl });
    }
  }

  // 6. Execution - Generate the Branded Pixels
  const { imageBuffer, usage } = await generateVisualContent({
    prompt: finalPrompt,
    brandLogoBuffer,
    brandLogoMimeType: "image/png", // High-fidelity standard
  });

  // 7. Persistence - Upload to R2 and add to Media Catalog
  const assetName = `AI_Branded_${Date.now()}`;
  const asset = await createMediaAsset({
    businessProfileId,
    userId,
    fileBuffer: imageBuffer,
    originalName: `${assetName}.png`,
    mimeType: "image/png",
    name: assetName,
    instructions: `Branded AI Image: ${userPrompt}`,
  });

  // 8. Link to Content Plan Post (if provided)
  if (postId) {
    await prisma.contentPlanPost.update({
      where: { id: postId },
      data: {
        imageUrl: asset.publicUrl,
        status: "generated", 
      },
    });
  }

  // 9. Record Usage
  await recordAiUsage({
    userId,
    businessProfileId,
    ...usage,
    operation: "gemini_image_generation_branded",
  });

  return asset;
}

/**
 * Perform conversational editing/refining on an existing asset.
 */
export async function refineGeminiVisual(params: {
  userId: number;
  businessProfileId: number;
  assetId: number;
  instruction: string;
}) {
  const { userId, businessProfileId, assetId, instruction } = params;

  // 1. Quota Check (Edits are medium-high value)
  await assertQuotaAvailable(userId, businessProfileId);

  // 2. Fetch the base asset
  const asset = await prisma.businessProfileMedia.findFirst({
    where: { id: assetId, userId },
  });
  if (!asset) throw new Error("Source asset not found");

  // Since we stream to R2, we need it as a Buffer back to send to Gemini
  // For production efficiency, in a real env, we'd fetch from R2 here.
  // For now, let's look for it in the local FS or fetch via public URL
  const res = await fetch(asset.publicUrl);
  const arrayBuffer = await res.arrayBuffer();
  const imageBuffer = Buffer.from(arrayBuffer);

  // 3. Command the pixels
  const { imageBuffer: refinedBuffer, usage } = await generateVisualContent({
    prompt: instruction,
    imageBuffer,
    mimeType: asset.mimeType,
  });

  // 4. Save as a NEW asset (keep version history)
  const refinedAssetName = `${asset.name}_Refined_${Date.now()}`;
  const refinedAsset = await createMediaAsset({
    businessProfileId,
    userId,
    fileBuffer: refinedBuffer,
    originalName: `${refinedAssetName}.png`,
    mimeType: "image/png",
    name: refinedAssetName,
    instructions: `AI Refinement: ${instruction} (Source: ${asset.name})`,
  });

  // 5. Log Billing
  await recordAiUsage({
    userId,
    businessProfileId,
    ...usage,
    operation: "gemini_image_refine_e2e",
  });

  return refinedAsset;
}
