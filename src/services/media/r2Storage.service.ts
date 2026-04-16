import { PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import path from "path";
import { r2Client, R2_BUCKET, R2_PUBLIC_URL } from "../../config/r2";
import { logger } from "../../utils/logger";

/**
 * Generates a namespaced, collision-safe R2 key for a business asset.
 * Format: media/bp_{businessProfileId}/{uuid}_{sanitizedFilename}
 */
export function generateR2Key(businessProfileId: number, originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  const safeName = path.basename(originalName, ext)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .substring(0, 60);
  return `media/bp_${businessProfileId}/${randomUUID()}_${safeName}${ext}`;
}

/**
 * Uploads a file buffer to Cloudflare R2.
 * Returns the public URL for the uploaded object.
 */
export async function uploadToR2(
  key: string,
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  await r2Client.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
      // Cache for 1 year — media assets are immutable (new upload = new key)
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );

  const publicUrl = `${R2_PUBLIC_URL}/${key}`;
  logger.info("r2.upload.success", { key, mimeType, publicUrl });
  return publicUrl;
}

/**
 * Deletes an object from R2 by key.
 * Called only during hard-cleanup jobs, never on soft-delete.
 */
export async function deleteFromR2(key: string): Promise<void> {
  await r2Client.send(
    new DeleteObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
    }),
  );
  logger.info("r2.delete.success", { key });
}
