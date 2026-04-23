import sharp from "sharp";
import { logger } from "../../utils/logger";

export type WatermarkPosition = "TOP_LEFT" | "TOP_RIGHT" | "BOTTOM_LEFT" | "BOTTOM_RIGHT" | "CENTER";

/**
 * Service to deterministically composite a brand logo onto an image.
 * This acts as the "Elite Fallback" for when AI fails to natively integrate branding.
 */
export async function applyWatermark(params: {
  imageBuffer: Buffer;
  logoBuffer: Buffer;
  position: WatermarkPosition;
  opacity?: number;
  marginPercent?: number; // Percent of total image size for margin
}) {
  const { 
    imageBuffer, 
    logoBuffer, 
    position, 
    opacity = 0.9, 
    marginPercent = 4 
  } = params;

  try {
    const mainImage = sharp(imageBuffer);
    const logoImage = sharp(logoBuffer);

    const [mainMeta, logoMeta] = await Promise.all([
      mainImage.metadata(),
      logoImage.metadata()
    ]);

    if (!mainMeta.width || !mainMeta.height || !logoMeta.width || !logoMeta.height) {
      throw new Error("Could not retrieve image metadata for watermarking");
    }

    // 1. Calculate Logo Scaling (Target logo to be ~15% of image width)
    const targetLogoWidth = Math.round(mainMeta.width * 0.15);
    const scaleFactor = targetLogoWidth / logoMeta.width;
    const targetLogoHeight = Math.round(logoMeta.height * scaleFactor);

    const resizedLogoBuffer = await logoImage
      .resize(targetLogoWidth, targetLogoHeight, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha(opacity)
      .toBuffer();

    // 2. Calculate Coordinates
    const margin = Math.round(mainMeta.width * (marginPercent / 100));
    let left = 0;
    let top = 0;

    switch (position) {
      case "TOP_LEFT":
        left = margin;
        top = margin;
        break;
      case "TOP_RIGHT":
        left = mainMeta.width - targetLogoWidth - margin;
        top = margin;
        break;
      case "BOTTOM_LEFT":
        left = margin;
        top = mainMeta.height - targetLogoHeight - margin;
        break;
      case "BOTTOM_RIGHT":
        left = mainMeta.width - targetLogoWidth - margin;
        top = mainMeta.height - targetLogoHeight - margin;
        break;
      case "CENTER":
        left = Math.round((mainMeta.width - targetLogoWidth) / 2);
        top = Math.round((mainMeta.height - targetLogoHeight) / 2);
        break;
    }

    // 3. Composite
    const brandedImageBuffer = await mainImage
      .composite([
        {
          input: resizedLogoBuffer,
          top,
          left,
          blend: "over"
        }
      ])
      .toBuffer();

    logger.info("watermark.applied_successfully", { position, targetLogoWidth });
    return brandedImageBuffer;

  } catch (err: any) {
    logger.error("watermark.apply_failed", { error: err.message });
    // Fallback to original image if watermarking fails
    return imageBuffer;
  }
}
