import { AgentClient } from "@modules/ai-agent/client/agent.client";
import { createMediaAsset } from "./mediaLibrary.service";
import { recordAiUsage, assertQuotaAvailable } from "../../billing/billing.service";
import { applyWatermark, WatermarkPosition } from "./watermark.service";
import { logger } from "@utils/logger";
import prisma from "@config/prisma";
import { env } from "@config/env";
import { AppError } from "@middlewares/errorHandler.middleware";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { internalClient } from "@utils/apiClient";
import { r2Client, R2_BUCKET } from "../r2";


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
 * Service to handle end-to-end Gemini 3.1 Flash Image generation and editing.
 */
export async function createGeminiVisual(params: {
  userId: number;
  businessProfileId: number;
  userPrompt: string;
  postId?: number;
}) {
  return AgentClient.runAgent({
    business_profile_id: params.businessProfileId,
    user_id: params.userId,
    messages: [],
    stage: "fast",
  } as any) as any;
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
  return AgentClient.runAgent({
    business_profile_id: params.businessProfileId,
    user_id: params.userId,
    messages: [],
    stage: "fast",
  } as any) as any;
}






