import { GoogleGenAI, Modality } from "@google/genai";
import { createMediaAsset } from "./mediaLibrary.service";
import { recordAiUsage, assertQuotaAvailable } from "../../billing/billing.service";
import { applyWatermark, WatermarkPosition } from "./watermark.service";
import { logger } from "@utils/logger";
import prisma from "@config/prisma";
import { AppError } from "@middlewares/errorHandler.middleware";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, R2_BUCKET } from "../r2";
import { internalClient } from "@utils/apiClient";

const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const MAX_PROMPT_CHARS = 12_000;
const AESTHETIC_MAPPINGS: Record<string, string> = {
  BOLD_MODERN: "high-end editorial, strong contrast, avant-garde composition",
  EGYPTIAN_STREET: "vibrant Cairo street photography, rich texture, cinematic HDR",
  KHALEEJI_LUXURY: "premium minimalism, gold and marble, soft desert sunrise",
  RAMADAN_OCCASIONS: "lantern glow, navy and crescent gold palette, spiritual warmth",
  CAIRO_MODERN: "Mediterranean-African fusion, warm architectural lighting",
  ISLAMIC_GEOMETRIC: "precise geometric patterns, liquid gold and deep emerald",
  PHARAONIC_HERITAGE: "limestone textures, dramatic sunset shadows, modern heritage",
  MENA_TECH: "futuristic digital twin aesthetic, glassmorphism, crisp light",
};
const ART_STYLE_MAPPINGS: Record<string, string> = {
  REALISTIC: "photorealistic, natural lighting", CARTOON_3D: "3D rendered cartoon, smooth shading",
  FLAT_ILLUSTRATION: "flat design illustration, minimal shading", ANIME: "anime, cel shaded, vibrant",
  WATERCOLOR: "watercolor painting, soft edges", ARABIC_CALLIGRAPHY: "decorative Arabic calligraphy",
  CINEMATIC: "cinematic lighting, dramatic composition", COMIC_POP: "comic book, bold outlines, pop art",
  MINIMAL_LINE: "minimal line art, clean single-color lines", ISOMETRIC_3D: "isometric 3D, pastel colors",
};

function groundedPrompt(prompt: string, profile: any, refine?: string) {
  const aesthetic = AESTHETIC_MAPPINGS[profile.visualAesthetic] || "sleek, modern, globally competitive";
  const style = ART_STYLE_MAPPINGS[profile.artStyle] || "photorealistic, high-fidelity commercial image";
  const colors = [profile.brandPrimaryColor, profile.brandSecondaryColor, profile.brandAccentColor].filter(Boolean).join(", ") || "vibrant and harmonious colors";
  const branding = (profile as any).brandWatermarkEnabled ? "Do not render logos or text; branding is applied after generation." : "Integrate branding naturally when appropriate.";
  return ["Create a production-ready commercial visual.", `Aesthetic: ${aesthetic}. Rendering: ${style}. Color DNA: ${colors}.`, branding,
    refine ? `Refine the existing asset according to: ${refine}` : `Creative direction: ${prompt}`,
    "Use clear subject focus, professional lighting, and balanced composition."] .join(" ").slice(0, MAX_PROMPT_CHARS);
}

function aiClient() {
  // Wkil's monolith historically called this credential GEMINI_API_KEY;
  // deployments that share the agent-service Google secret use GOOGLE_API_KEY.
  // Accept both names while keeping the value server-side only.
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new AppError("Gemini image provider is not configured", 503);
  return new GoogleGenAI({ apiKey });
}

async function generateImage(prompt: string, source?: { data: string; mimeType: string }) {
  const contents: any = source ? [{ text: prompt }, { inlineData: { data: source.data, mimeType: source.mimeType } }] : prompt;
  const response = await aiClient().models.generateContent({ model: IMAGE_MODEL, contents, config: { responseModalities: [Modality.IMAGE] } });
  const part = response.candidates?.[0]?.content?.parts?.find((item: any) => item.inlineData?.data);
  if (!part?.inlineData?.data) throw new AppError("Image provider returned no image", 502);
  const usage = response.usageMetadata || {};
  return { imageBuffer: Buffer.from(part.inlineData.data, "base64"), usage: {
    promptTokens: Number(usage.promptTokenCount || 0), completionTokens: Number(usage.candidatesTokenCount || 0), modelName: IMAGE_MODEL,
  } };
}

async function loadProfile(userId: number, businessProfileId: number) {
  const profile = await prisma.businessProfile.findFirst({ where: { id: businessProfileId, userId } });
  if (!profile) throw new AppError("Business profile not found", 404);
  return profile;
}

async function fetchLogo(profile: any): Promise<Buffer | undefined> {
  if (!profile.brandLogoUrl) return undefined;
  try {
    const response = await internalClient.get(profile.brandLogoUrl, { responseType: "arraybuffer" });
    return Buffer.from(response.data);
  } catch {
    logger.warn("gemini_visual.logo_fetch_failed", { businessProfileId: profile.id });
    return undefined;
  }
}

export async function createGeminiVisual(params: { userId: number; businessProfileId: number; userPrompt: string; postId?: number }) {
  const { userId, businessProfileId, userPrompt, postId } = params;
  const profile = await loadProfile(userId, businessProfileId);
  await assertQuotaAvailable(userId, businessProfileId);
  if (postId) await prisma.contentPlanPost.update({ where: { id: postId }, data: { status: "generating" } });
  try {
    const generated = await generateImage(groundedPrompt(userPrompt, profile));
    const logo = (profile as any).brandWatermarkEnabled ? await fetchLogo(profile) : undefined;
    const imageBuffer = logo ? await applyWatermark({ imageBuffer: generated.imageBuffer, logoBuffer: logo,
      position: ((profile as any).watermarkPosition as WatermarkPosition) || "BOTTOM_RIGHT" }) : generated.imageBuffer;
    const assetName = `AI_Branded_${Date.now()}`;
    const asset = await createMediaAsset({ businessProfileId, userId, fileBuffer: imageBuffer, originalName: `${assetName}.png`, mimeType: "image/png", name: assetName, instructions: `Branded AI Image: ${userPrompt}`, usageScope: "CONTENT_ASSET" });
    if (postId) await prisma.contentPlanPost.update({ where: { id: postId }, data: { imageUrl: asset.publicUrl, mediaAssetId: asset.id, status: "generated" } });
    await recordAiUsage({ userId, businessProfileId, ...generated.usage, operation: "gemini_image_generation" });
    return asset;
  } catch (error) {
    if (postId) await prisma.contentPlanPost.update({ where: { id: postId }, data: { status: "generated" } }).catch(() => undefined);
    throw error;
  }
}

export async function refineGeminiVisual(params: { userId: number; businessProfileId: number; assetId: number; instruction: string; postId?: number }) {
  const { userId, businessProfileId, assetId, instruction, postId } = params;
  const profile = await loadProfile(userId, businessProfileId);
  await assertQuotaAvailable(userId, businessProfileId);
  const asset = await prisma.businessProfileMedia.findFirst({ where: { id: assetId, userId, businessProfileId } });
  if (!asset) throw new AppError("Source asset not found", 404);
  if (postId) await prisma.contentPlanPost.update({ where: { id: postId }, data: { status: "generating" } });
  try {
    const object = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: asset.r2Key }));
    const body = await object.Body?.transformToByteArray();
    if (!body) throw new AppError("Source asset data empty", 502);
    const generated = await generateImage(groundedPrompt(instruction, profile, instruction), { data: Buffer.from(body).toString("base64"), mimeType: asset.mimeType || "image/png" });
    const logo = (profile as any).brandWatermarkEnabled ? await fetchLogo(profile) : undefined;
    const imageBuffer = logo ? await applyWatermark({ imageBuffer: generated.imageBuffer, logoBuffer: logo,
      position: ((profile as any).watermarkPosition as WatermarkPosition) || "BOTTOM_RIGHT" }) : generated.imageBuffer;
    const refinedName = `${asset.name}_Refined_${Date.now()}`;
    const refined = await createMediaAsset({ businessProfileId, userId, fileBuffer: imageBuffer, originalName: `${refinedName}.png`, mimeType: "image/png", name: refinedName, instructions: `AI Refinement: ${instruction} (Source: ${asset.name})`, usageScope: "CONTENT_ASSET" });
    if (postId) await prisma.contentPlanPost.update({ where: { id: postId }, data: { imageUrl: refined.publicUrl, mediaAssetId: refined.id, status: "generated" } });
    await recordAiUsage({ userId, businessProfileId, ...generated.usage, operation: "gemini_image_refine" });
    return refined;
  } catch (error) {
    if (postId) await prisma.contentPlanPost.update({ where: { id: postId }, data: { status: "generated" } }).catch(() => undefined);
    throw error;
  }
}
