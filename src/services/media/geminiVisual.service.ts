import { generateVisualContent, generateContent } from "../../config/gemini";
import { createMediaAsset } from "./mediaLibrary.service";
import { recordAiUsage, assertQuotaAvailable } from "../billing.service";
import { logger } from "../../utils/logger";
import prisma from "../../config/prisma";

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

  // 1. Pre-flight quota check (Manual Image Gen is high-value)
  await assertQuotaAvailable(userId, businessProfileId);

  // 2. "Art Director" - Use Gemini to beautify the prompt for production grade
  const artDirectorPrompt = `You are a world-class Social Media Art Director.
Convert the following user intent into a high-fidelity, photorealistic photographic prompt for gemini-3.1-flash-image.
Intent: ${userPrompt}

[CRITICAL INSTRUCTIONS]:
1. Style: Focus on "Deep Professional Photography", cinematic lighting, and 8k resolution.
2. Composition: Modern, centered, and optimized for social media engagement.
3. Brand Match: Reflect the professional tier of a premium business service.
4. Output: Return ONLY the final prompt string. No conversational filler.`;

  const { text: enhancedPrompt } = await generateContent(artDirectorPrompt);
  const finalPrompt = (enhancedPrompt || userPrompt).trim();

  logger.info("gemini_visual.generating", { userId, businessProfileId, finalPrompt });

  // 3. Execution - Generate the Pixels
  const { imageBuffer, usage } = await generateVisualContent({
    prompt: finalPrompt,
  });

  // 4. Persistence - Upload to R2 and add to Media Catalog
  const assetName = `AI_Gen_${Date.now()}`;
  const asset = await createMediaAsset({
    businessProfileId,
    userId,
    fileBuffer: imageBuffer,
    originalName: `${assetName}.png`,
    mimeType: "image/png",
    name: assetName,
    instructions: `AI Generated from prompt: ${userPrompt}`,
  });

  // 5. Link to Content Plan Post (if provided)
  if (postId) {
    await prisma.contentPlanPost.update({
      where: { id: postId },
      data: {
        imageUrl: asset.publicUrl,
        status: "generated", 
      },
    });
  }

  // 6. Record Usage
  await recordAiUsage({
    userId,
    businessProfileId,
    ...usage,
    operation: "gemini_image_generation_e2e",
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
