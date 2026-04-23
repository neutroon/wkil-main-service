import { generateVisualContent, generateContent } from "../../config/gemini";
import { createMediaAsset } from "./mediaLibrary.service";
import { recordAiUsage, assertQuotaAvailable } from "../billing.service";
import { applyWatermark, WatermarkPosition } from "./watermark.service";
import { logger } from "../../utils/logger";
import prisma from "../../config/prisma";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, R2_BUCKET } from "../../config/r2";

import axios from "axios";

/**
 * Aesthetic DNA Mappings (The Vibe)
 */
const AESTHETIC_MAPPINGS: Record<string, string> = {
  BOLD_MODERN: "High-end editorial fashion photography, strong contrast, Swiss design influence, bold typography overlays, avant-garde composition",
  EGYPTIAN_STREET: "Vibrant urban hustle, high-dynamic range (HDR), cinematic street photography, neon Arabic signage, rich textures of Cairo at night",
  KHALEEJI_LUXURY: "Ultra-premium opulent minimalism, gold and marble accents, soft desert sunrise lighting, fluid calligraphy, high-fashion luxury brand vibe",
  RAMADAN_OCCASIONS: "Atmospheric lantern glow, deep navy and crescent gold palette, ethereal bokeh, spiritual warmth, intricate Islamic patterns",
  CAIRO_MODERN: "Sleek Mediterranean-African fusion, warm architectural lighting, contemporary Nile-side aesthetic, balanced bilingual typography",
  ISLAMIC_GEOMETRIC: "Master-level 3D procedural patterns, volumetric lighting, fractal symmetry, liquid gold and deep emerald jewel tones",
  PHARAONIC_HERITAGE: "Timeless archaeological grandeur, limestone textures, dramatic sunset shadows, hieroglyphic elegance, modern heritage luxury",
  MENA_TECH: "Futuristic digital-twin aesthetic, liquid gradients, clean glassmorphism, tech-startup blueprint style, crisp light-mode visuals",
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

  const artDirectorPrompt = `You are a world-class Social Media Art Director and Master Photographer.
${isRefine ? "You are performing a high-end photo retouch and asset refinement." : "You are conceptualizing an industry-grade commercial visual."}

[BRAND IDENTITY & PRODUCTION TIER]:
- Aesthetic Essence: ${aestheticBrief || "Sleek, Modern, and Globally Competitive"}
- Rendering Engine: ${styleBrief || "Photorealistic 8K Cinema Grade"}
- Color DNA: ${colorBrief || "Vibrant and Harmonious"}

[MANUAL PRODUCTION SPECIFICATIONS]:
1. Camera Settings: Shoot on Phase One XF, 100MP, 80mm Lens, f/2.8 for creamy bokeh, ISO 100 for zero noise.
2. Lighting Architecture: Use Three-Point Lighting with soft-boxes, global illumination, Ray-traced reflections, and volumetric fog for depth.
3. Post-Processing: Color grade for "Cinematic Teal & Orange" or "High-Fashion Monochrome" where appropriate. Sharp focus on the subject.
4. Texture Depth: Macro-level detail on surfaces (fabric, skin, metal, stone). Unreal Engine 5.4 Path Tracing quality.
5. Composition: Masterful use of Negative Space, Golden Ratio, and Dynamic Leading Lines.
6. Native Branding: ${profile.brandWatermarkEnabled ? "DO NOT generate any logos or text. Return a CLEAN, pristine commercial asset. Branding will be added in post." : `Integrate the logo naturally as a premium physical element (e.g. etched in glass) or high-fidelity placement in the ${profile.watermarkPosition || "BOTTOM_RIGHT"}.`}
${isRefine ? `7. The Evolution: The current asset is "${sourcePrompt}". Apply the surgical refinement: "${userPrompt}" while boosting total visual weight and luxury feel.` : `7. The Narrative: ${userPrompt}`}
8. Formatting: Return ONLY the optimized, high-density prompt string. No conversational meta-talk.`;

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

  // 2b. Resilience: Set Post Status to 'generating' immediately
  if (postId) {
    await prisma.contentPlanPost.update({
      where: { id: postId },
      data: { status: "generating" },
    });
  }

  try {
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

    // 6. Persistence & Elite Fallback Watermarking
    let finalImageBuffer = imageBuffer;
    
    if (profile.brandWatermarkEnabled && brandLogoBuffer) {
      logger.info("gemini_visual.applying_manual_watermark", { businessProfileId, position: profile.watermarkPosition });
      finalImageBuffer = await applyWatermark({
        imageBuffer,
        logoBuffer: brandLogoBuffer,
        position: (profile.watermarkPosition as WatermarkPosition) || "BOTTOM_RIGHT"
      });
    }

    const assetName = `AI_Branded_${Date.now()}`;
    const asset = await createMediaAsset({
      businessProfileId,
      userId,
      fileBuffer: finalImageBuffer,
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
  } catch (err: any) {
    // Fallback: Restore status if it failed so user can try again
    if (postId) {
      await prisma.contentPlanPost.update({
        where: { id: postId },
        data: { status: "generated" }, // Back to ready state
      });
    }
    throw err;
  }
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

  // 2b. Resilience: Set Post Status to 'generating' immediately
  if (postId) {
    await prisma.contentPlanPost.update({
      where: { id: postId },
      data: { status: "generating" },
    });
  }

  try {
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

    // 6. Persistence & Elite Fallback Watermarking
    let finalImageBuffer = refinedBuffer;
    if (profile.brandWatermarkEnabled && brandLogoBuffer) {
      logger.info("gemini_visual.applying_manual_refine_watermark", { businessProfileId, position: profile.watermarkPosition });
      finalImageBuffer = await applyWatermark({
        imageBuffer: refinedBuffer,
        logoBuffer: brandLogoBuffer,
        position: (profile.watermarkPosition as WatermarkPosition) || "BOTTOM_RIGHT"
      });
    }

    const refinedAssetName = `${asset.name}_Refined_${Date.now()}`;
    const refinedAsset = await createMediaAsset({
      businessProfileId,
      userId,
      fileBuffer: finalImageBuffer,
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
          status: "generated",
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
  } catch (err: any) {
    // Fallback: Restore status if it failed
    if (postId) {
      await prisma.contentPlanPost.update({
        where: { id: postId },
        data: { status: "generated" },
      });
    }
    throw err;
  }
}
