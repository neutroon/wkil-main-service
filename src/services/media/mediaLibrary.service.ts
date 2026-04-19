import { GetObjectCommand } from "@aws-sdk/client-s3";
import prisma from "../../config/prisma";
import { logger } from "../../utils/logger";
import { r2Client, R2_BUCKET } from "../../config/r2";
import { generateR2Key, uploadToR2 } from "./r2Storage.service";
import { uploadWhatsAppMedia, uploadMessengerMedia } from "../meta/metaUpload.service";
import { decryptFacebookSecret } from "../../utils/tokenCrypto";

// Allowed MIME types and their media type classifications
const MIME_TO_MEDIA_TYPE: Record<string, "image" | "document" | "video"> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/gif": "image",
  "image/webp": "image",
  "application/pdf": "document",
  "application/msword": "document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/vnd.ms-excel": "document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "document",
  "application/vnd.ms-powerpoint": "document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "document",
  "video/mp4": "video",
  "video/quicktime": "video",
};

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

/**
 * Creates a new media asset: validates, uploads to R2, saves to DB,
 * and enqueues background Meta platform registration.
 */
export async function createMediaAsset(params: {
  businessProfileId: number;
  userId: number;
  fileBuffer: Buffer;
  originalName: string;
  mimeType: string;
  name: string;
  instructions: string;
}) {
  const { businessProfileId, userId, fileBuffer, originalName, mimeType, name, instructions } = params;

  // 1. Validate ownership
  const profile = await prisma.businessProfile.findFirst({
    where: { id: businessProfileId, userId },
  });
  if (!profile) throw new Error("Business profile not found or access denied");

  // 2. Validate MIME type
  const mediaType = MIME_TO_MEDIA_TYPE[mimeType];
  if (!mediaType) throw new Error(`Unsupported file type: ${mimeType}`);

  // 3. Validate file size
  if (fileBuffer.length > MAX_FILE_SIZE) {
    throw new Error(`File exceeds maximum size of 25MB (received ${Math.round(fileBuffer.length / 1024 / 1024)}MB)`);
  }

  // 4. Sanitize AI instructions (strip characters that could cause prompt injection)
  const sanitizedInstructions = instructions
    .replace(/[<>{}\[\]\\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .substring(0, 500); // Hard cap to prevent runaway prompts

  // 5. Upload to R2
  const r2Key = generateR2Key(businessProfileId, originalName);
  const publicUrl = await uploadToR2(r2Key, fileBuffer, mimeType);

  // 6. Save to DB with PENDING platform sync status
  const asset = await prisma.businessProfileMedia.create({
    data: {
      businessProfileId,
      userId,
      name: name.trim().substring(0, 100),
      instructions: sanitizedInstructions,
      mediaType,
      mimeType,
      fileSizeBytes: fileBuffer.length,
      r2Key,
      publicUrl,
      whatsappSyncStatus: "PENDING",
      messengerSyncStatus: "PENDING",
    },
  });

  // 7. Kick off background Meta registration (non-blocking — does NOT delay response)
  void registerAssetWithMeta(asset.id).catch((err) => {
    logger.error("media.meta_registration.background_failed", { assetId: asset.id, error: err.message });
  });

  return asset;
}

/**
 * Registers an existing asset with WhatsApp and Messenger platforms.
 * Called automatically after upload and by the refresh scheduler.
 */
export async function registerAssetWithMeta(assetId: number) {
  const asset = await prisma.businessProfileMedia.findUnique({
    where: { id: assetId },
    include: {
      businessProfile: {
        include: {
          whatsAppAccounts: { where: { isActive: true }, take: 1 },
          facebookPages: { where: { isActive: true }, take: 1 },
        },
      },
    },
  });

  if (!asset) return;

  // Fetch the file from R2 directly via S3 SDK (Internal call)
  let fileBuffer: Buffer;
  try {
    const getObj = await r2Client.send(
      new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: asset.r2Key,
      })
    );
    const bodyString = await getObj.Body?.transformToByteArray();
    if (!bodyString) throw new Error("Empty body from R2");
    fileBuffer = Buffer.from(bodyString);
  } catch (err: any) {
    logger.error("media.meta_registration.r2_storage_fetch_failed", { assetId, error: err.message });
    return;
  }

  const originalName = asset.r2Key.split("/").pop() || "file";

  // ── WhatsApp Registration ────────────────────────────────────────────────────
  const waAccount = asset.businessProfile.whatsAppAccounts[0];
  if (waAccount) {
    try {
      const accessToken = decryptFacebookSecret(waAccount.accessToken);
      const mediaId = await uploadWhatsAppMedia(
        waAccount.phoneNumberId,
        accessToken,
        fileBuffer,
        originalName,
        asset.mimeType,
      );

      // WhatsApp IDs expire after 30 days — store expiry for scheduler
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 28); // 28 days to be safe

      await prisma.businessProfileMedia.update({
        where: { id: assetId },
        data: {
          whatsappMediaId: mediaId,
          whatsappMediaExpiresAt: expiresAt,
          whatsappSyncStatus: "SYNCED",
        },
      });
      logger.info("media.whatsapp.registered", { assetId, mediaId });
    } catch (err: any) {
      logger.error("media.whatsapp.registration_failed", { assetId, error: err.message });
      await prisma.businessProfileMedia.update({
        where: { id: assetId },
        data: { whatsappSyncStatus: "FAILED" },
      });
    }
  }

  // ── Messenger Registration ───────────────────────────────────────────────────
  const fbPage = asset.businessProfile.facebookPages[0];
  if (fbPage) {
    try {
      const accessToken = decryptFacebookSecret(fbPage.pageAccessToken);
      const attachmentId = await uploadMessengerMedia(
        fbPage.pageId,
        accessToken,
        fileBuffer,
        originalName,
        asset.mimeType,
      );

      await prisma.businessProfileMedia.update({
        where: { id: assetId },
        data: {
          messengerAttachmentId: attachmentId,
          messengerSyncStatus: "SYNCED",
        },
      });
      logger.info("media.messenger.registered", { assetId, attachmentId });
    } catch (err: any) {
      logger.error("media.messenger.registration_failed", { assetId, error: err.message });
      await prisma.businessProfileMedia.update({
        where: { id: assetId },
        data: { messengerSyncStatus: "FAILED" },
      });
    }
  }
}

/**
 * Resolves a named media asset to the correct delivery identifier for a channel.
 * This is the critical bridge between the AI's decision and the actual delivery.
 * Provides graceful fallback: platformId → publicUrl → null
 */
export async function resolveAssetForChannel(
  assetName: string,
  businessProfileId: number,
  channel: "web" | "whatsapp" | "messenger",
): Promise<{
  mediaId?: string;
  url?: string;
  mediaType: string;
  mimeType: string;
  caption?: string;
} | null> {
  const asset = await prisma.businessProfileMedia.findFirst({
    where: {
      businessProfileId,
      name: assetName,
      isActive: true,
      deletedAt: null,
    },
  });

  if (!asset) return null;

  if (channel === "web") {
    return { url: asset.publicUrl, mediaType: asset.mediaType, mimeType: asset.mimeType };
  }

  if (channel === "whatsapp") {
    return {
      mediaId: asset.whatsappMediaId ?? undefined,
      url: asset.publicUrl, // Fallback for text link
      mediaType: asset.mediaType,
      mimeType: asset.mimeType,
    };
  }

  if (channel === "messenger") {
    return {
      mediaId: asset.messengerAttachmentId ?? undefined,
      url: asset.publicUrl,
      mediaType: asset.mediaType,
      mimeType: asset.mimeType,
    };
  }

  return null;
}

/**
 * Soft-deletes a media asset.
 * The R2 file and DB record are preserved for historical message integrity.
 */
export async function softDeleteAsset(assetId: number, userId: number): Promise<void> {
  const asset = await prisma.businessProfileMedia.findFirst({
    where: { id: assetId, userId },
  });
  if (!asset) throw new Error("Asset not found or access denied");

  await prisma.businessProfileMedia.update({
    where: { id: assetId },
    data: { isActive: false, deletedAt: new Date() },
  });
  logger.info("media.soft_deleted", { assetId, userId });
}

/**
 * Lists all active media assets for a business profile.
 */
export async function listMediaAssets(businessProfileId: number, userId: number) {
  return prisma.businessProfileMedia.findMany({
    where: { businessProfileId, userId, isActive: true, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      instructions: true,
      mediaType: true,
      mimeType: true,
      fileSizeBytes: true,
      publicUrl: true,
      whatsappSyncStatus: true,
      messengerSyncStatus: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

/**
 * Updates only the name and instructions of an existing asset.
 * Does NOT trigger re-upload.
 */
export async function updateMediaAssetMeta(
  assetId: number,
  userId: number,
  data: { name?: string; instructions?: string },
) {
  const asset = await prisma.businessProfileMedia.findFirst({
    where: { id: assetId, userId, isActive: true },
  });
  if (!asset) throw new Error("Asset not found or access denied");

  const updateData: any = {};
  if (data.name) updateData.name = data.name.trim().substring(0, 100);
  if (data.instructions) {
    updateData.instructions = data.instructions
      .replace(/[<>{}\[\]\\]/g, "")
      .trim()
      .substring(0, 500);
  }

  return prisma.businessProfileMedia.update({ where: { id: assetId }, data: updateData });
}
