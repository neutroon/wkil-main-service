import { generateVisualContent, generateContent } from "../../config/gemini";
import { createMediaAsset } from "./mediaLibrary.service";
import { recordAiUsage, assertQuotaAvailable } from "../billing.service";
import { logger } from "../../utils/logger";
import prisma from "../../config/prisma";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, R2_BUCKET } from "../../config/r2";

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
 * Art Director Helper: Injects Brand Identity into prompts
 */
async function groundingPromptWithBrand(params: {
  userPrompt: string,
  profile: any,
  isRefine?: boolean,
  sourcePrompt?: string
}) {
  const { userPrompt, profile, isRefine, sourcePrompt } = params;
  
  const aestheticBrief = profile.visualAesthetic ? AESTHETIC_MAPPINGS[profile.visualAesthetic] || "" : "";
  const styleBrief = profile.artStyle ? ART_STYLE_MAPPINGS[profile.artStyle] || "" : "";
  const colorBrief = [profile.brandPrimaryColor, profile.brandSecondaryColor, profile.brandAccentColor]
    .filter(Boolean)
    .join(", ");

  const artDirectorPrompt = `You are a world-class Social Media Art Director.
${isRefine ? "You are refining an existing image based on new instructions." : "You are creating a new social media image."}

[BRAND IDENTITY]:
- Aesthetic Vibe: ${aestheticBrief || "Modern and Professional"}
- Technical Style: ${styleBrief || "High-quality photography"}
- Color Palette: ${colorBrief || "Natural and vibrant"}

[CRITICAL INSTRUCTIONS]:
1. Style Execution: Focus on "Ultra-High Definition Photography", master-level lighting, shallow depth of field (f/1.8), and global illumination.
2. Style Consistency: Ensure the result strictly adheres to the technical style and aesthetic vibe mentioned above.
3. Color Accuracy: Use the provided hex codes (${colorBrief}) as the dominant or accent colors in the composition. Ensure they feel like a natural part of the brand's DNA.
4. Composition: Perfectly balanced (rule-of-thirds or symmetrical), optimized for elite social media engagement.
5. Rendering: Ray-traced textures, no artifacts, realistic shadows and reflections.
6. Native Branding: If a logo is provided in the multimodal context, integrate it naturally into the scene or as a high-fidelity watermark in the ${profile.watermarkPosition || "BOTTOM_RIGHT"} corner.
${isRefine ? `7. Evolution: The previous intent was "${sourcePrompt}". Now, apply the following change: "${userPrompt}" while strictly maintaining the brand kit and technical quality above.` : `7. Intent: ${userPrompt}`}
8. Output: Return ONLY the final photographic prompt string. No conversational filler.`;

  const { text: enhancedPrompt } = await generateContent(artDirectorPrompt);
  return (enhancedPrompt || userPrompt).trim();
}

/**
 * Service to handle end-to-end Gemini 3.1 Flash Image generation and editing.
 */
export async function createGeminiVisual(params: {
  userId: number;
  businessProfileId: number;
  userPrompt: string;
  postId?: number; 
}) {
  const { userId, businessProfileId, userPrompt, postId } = params;

  // 1. Fetch Business Profile and Brand Kit
  const profile = await prisma.businessProfile.findFirst({
    where: { id: businessProfileId, userId },
  });

  if (!profile) throw new Error("Business profile not found");

  // 2. Pre-flight quota check
  await assertQuotaAvailable(userId, businessProfileId);

  // 3. Grounding - Use Art Director to beautify the prompt with brand grounding
  const finalPrompt = await groundingPromptWithBrand({ userPrompt, profile });

  logger.info("gemini_visual.generating_branded", { userId, businessProfileId, finalPrompt });

  // 4. Fetch Brand Logo for Multimodal injection
  let brandLogoBuffer: Buffer | undefined;
  if (profile.brandLogoUrl) {
    try {
      const resp = await axios.get(profile.brandLogoUrl, { responseType: "arraybuffer" });
      brandLogoBuffer = Buffer.from(resp.data);
    } catch (err) {
      logger.warn("gemini_visual.logo_fetch_failed", { url: profile.brandLogoUrl });
    }
  }

  // 5. Execution - Generate the Branded Pixels
  const { imageBuffer, usage } = await generateVisualContent({
    prompt: finalPrompt,
    brandLogoBuffer,
    brandLogoMimeType: "image/png",
  });

  // 6. Persistence
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

  // 7. Link to Content Plan Post
  if (postId) {
    await prisma.contentPlanPost.update({
      where: { id: postId },
      data: {
        imageUrl: asset.publicUrl,
        mediaAssetId: asset.id,
        status: "generated", 
      },
    });
  }

  // 8. Record Usage
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
  postId?: number;
}) {
  const { userId, businessProfileId, assetId, instruction, postId } = params;

  // 1. Quota Check
  await assertQuotaAvailable(userId, businessProfileId);

  // 2. Fetch dependencies
  const [profile, asset] = await Promise.all([
    prisma.businessProfile.findFirst({ where: { id: businessProfileId, userId } }),
    prisma.businessProfileMedia.findFirst({ where: { id: assetId, userId } })
  ]);

  if (!profile) throw new Error("Business profile not found");
  if (!asset) throw new Error("Source asset not found");

  // 3. Grounding - Art Director for refinement
  const finalPrompt = await groundingPromptWithBrand({ 
    userPrompt: instruction, 
    profile, 
    isRefine: true,
    sourcePrompt: asset.instructions 
  });

  // 4. Fetch source image and brand logo
  let imageBuffer: Buffer;
  try {
    const getObj = await r2Client.send(
      new GetObjectCommand({ Bucket: R2_BUCKET, Key: asset.r2Key })
    );
    const bodyBytes = await getObj.Body?.transformToByteArray();
    if (!bodyBytes) throw new Error("Source asset data empty");
    imageBuffer = Buffer.from(bodyBytes);
  } catch (err: any) {
    logger.error("gemini_visual.refine_fetch_failed", { assetId, error: err.message });
    throw new Error("Failed to fetch source image for refinement.");
  }

  let brandLogoBuffer: Buffer | undefined;
  if (profile.brandLogoUrl) {
    try {
      const resp = await axios.get(profile.brandLogoUrl, { responseType: "arraybuffer" });
      brandLogoBuffer = Buffer.from(resp.data);
    } catch (err) {
       // Non-critical, continue without logo
    }
  }

  // 5. Command the pixels
  const { imageBuffer: refinedBuffer, usage } = await generateVisualContent({
    prompt: finalPrompt,
    imageBuffer,
    brandLogoBuffer,
    mimeType: asset.mimeType,
  });

  // 6. Save as a NEW asset
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

  // 7. Link to Content Plan Post
  if (postId) {
    await prisma.contentPlanPost.update({
      where: { id: postId },
      data: {
        imageUrl: refinedAsset.publicUrl,
        mediaAssetId: refinedAsset.id,
      },
    });
  }

  // 8. Log Billing
  await recordAiUsage({
    userId,
    businessProfileId,
    ...usage,
    operation: "gemini_image_refine_e2e",
  });

  return refinedAsset;
}
