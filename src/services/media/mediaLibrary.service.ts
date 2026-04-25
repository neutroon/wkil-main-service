import { GetObjectCommand } from "@aws-sdk/client-s3";
import prisma from "../../config/prisma";
import { logger } from "../../utils/logger";
import { r2Client, R2_BUCKET } from "../../config/r2";
import { generateR2Key, uploadToR2 } from "./r2Storage.service";
import {
  uploadWhatsAppMedia,
  uploadMessengerMedia,
} from "../meta/metaUpload.service";
import { decryptFacebookSecret } from "../../utils/tokenCrypto";
import { enqueueMediaSyncJob } from "../../queues/meta.queue";
import { syncMediaStatus } from "../socketSync.service";
import { AppError } from "../../middlewares/errorHandler.middleware";

// Allowed MIME types and their media type classifications
const MIME_TO_MEDIA_TYPE: Record<string, "image" | "document" | "video"> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/gif": "image",
  "image/webp": "image",
  "application/pdf": "document",
  "application/msword": "document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "document",
  "application/vnd.ms-excel": "document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    "document",
  "application/vnd.ms-powerpoint": "document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "document",
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
  const {
    businessProfileId,
    userId,
    fileBuffer,
    originalName,
    mimeType,
    name,
    instructions,
  } = params;

  // 1. Validate ownership
  const profile = await prisma.businessProfile.findFirst({
    where: { id: businessProfileId, userId },
  });
  if (!profile) throw new AppError("Business profile not found or access denied", 404);

  // 2. Validate MIME type
  const mediaType = MIME_TO_MEDIA_TYPE[mimeType];
  if (!mediaType) throw new AppError(`Unsupported file type: ${mimeType}`, 400);

  // 3. Validate file size
  if (fileBuffer.length > MAX_FILE_SIZE) {
    throw new AppError(
      `File exceeds maximum size of 25MB (received ${Math.round(fileBuffer.length / 1024 / 1024)}MB)`,
      400
    );
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

  // 7. Kick off durable background Meta registration
  await enqueueMediaSyncJob(asset.id);

  return asset;
}

/**
 * Registers an existing asset with WhatsApp and Messenger platforms.
 * Called automatically after upload and by the refresh scheduler.
 * Multi-Identity Awareness: Syncs to ALL connected accounts for the business.
 */
export async function registerAssetWithMeta(assetId: number) {
  const asset = await prisma.businessProfileMedia.findUnique({
    where: { id: assetId },
    include: {
      businessProfile: {
        include: {
          whatsAppAccounts: { where: { isActive: true } },
          facebookPages: { where: { isActive: true } },
        },
      },
    },
  });

  if (!asset) return;

  // 1. Fetch the file from R2 directly via S3 SDK
  let fileBuffer: Buffer;
  try {
    const getObj = await r2Client.send(
      new GetObjectCommand({
        Bucket: R2_BUCKET,
        Key: asset.r2Key,
      }),
    );
    const bodyString = await getObj.Body?.transformToByteArray();
    if (!bodyString) throw new AppError("Empty body from R2", 502);
    fileBuffer = Buffer.from(bodyString);

    // ── Tier-1 Checksum Validation ───────────────────────────────────────────
    if (fileBuffer.length !== asset.fileSizeBytes) {
      throw new AppError(
        `Data corruption detected: R2 size (${fileBuffer.length}) != DB size (${asset.fileSizeBytes})`,
        502
      );
    }
  } catch (err: any) {
    logger.error("media.meta_registration.integrity_check_failed", {
      assetId,
      error: err.message,
    });
    return;
  }

  const originalName = asset.r2Key.split("/").pop() || "file";

  // 2. WhatsApp Registration (Broadcast to all active accounts) ──────────────────
  for (const waAccount of asset.businessProfile.whatsAppAccounts) {
    try {
      const accessToken = decryptFacebookSecret(waAccount.accessToken);
      const mediaId = await uploadWhatsAppMedia(
        waAccount.phoneNumberId,
        accessToken,
        fileBuffer,
        originalName,
        asset.mimeType,
      );

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 28); // WhatsApp IDs expire in 30 days

      await prisma.businessProfileMediaSync.upsert({
        where: {
          mediaId_platform_identifier: {
            mediaId: assetId,
            platform: "whatsapp",
            identifier: waAccount.phoneNumberId,
          },
        },
        update: {
          externalMediaId: mediaId,
          expiresAt,
          status: "SYNCED",
          lastError: null,
        },
        create: {
          mediaId: assetId,
          platform: "whatsapp",
          identifier: waAccount.phoneNumberId,
          externalMediaId: mediaId,
          expiresAt,
          status: "SYNCED",
        },
      });

      // Maintain legacy field for backward compatibility
      await prisma.businessProfileMedia.update({
        where: { id: assetId },
        data: {
          whatsappMediaId: mediaId,
          whatsappMediaExpiresAt: expiresAt,
          whatsappSyncStatus: "SYNCED",
        },
      });

      logger.info("media.whatsapp.registered", {
        assetId,
        phoneId: waAccount.phoneNumberId,
        mediaId,
      });

      // Real-time UI notification
      syncMediaStatus({
        businessProfileId: asset.businessProfileId,
        assetId: asset.id,
        platform: "whatsapp",
        identifier: waAccount.phoneNumberId,
        status: "SYNCED",
      });
    } catch (err: any) {
      logger.error("media.whatsapp.registration_failed", {
        assetId,
        phoneId: waAccount.phoneNumberId,
        error: err.message,
      });
      await prisma.businessProfileMediaSync.upsert({
        where: {
          mediaId_platform_identifier: {
            mediaId: assetId,
            platform: "whatsapp",
            identifier: waAccount.phoneNumberId,
          },
        },
        update: { status: "FAILED", lastError: err.message },
        create: {
          mediaId: assetId,
          platform: "whatsapp",
          identifier: waAccount.phoneNumberId,
          externalMediaId: "FAILED",
          status: "FAILED",
          lastError: err.message,
        },
      });
    }
  }

  // 3. Messenger Registration (Broadcast to all active pages) ────────────────────
  for (const fbPage of asset.businessProfile.facebookPages) {
    try {
      const accessToken = decryptFacebookSecret(fbPage.pageAccessToken);
      const attachmentId = await uploadMessengerMedia(
        fbPage.pageId,
        accessToken,
        fileBuffer,
        originalName,
        asset.mimeType,
      );

      await prisma.businessProfileMediaSync.upsert({
        where: {
          mediaId_platform_identifier: {
            mediaId: assetId,
            platform: "messenger",
            identifier: fbPage.pageId,
          },
        },
        update: {
          externalMediaId: attachmentId,
          status: "SYNCED",
          lastError: null,
        },
        create: {
          mediaId: assetId,
          platform: "messenger",
          identifier: fbPage.pageId,
          externalMediaId: attachmentId,
          status: "SYNCED",
        },
      });

      // Maintain legacy field for backward compatibility
      await prisma.businessProfileMedia.update({
        where: { id: assetId },
        data: {
          messengerAttachmentId: attachmentId,
          messengerSyncStatus: "SYNCED",
        },
      });

      logger.info("media.messenger.registered", {
        assetId,
        pageId: fbPage.pageId,
        attachmentId,
      });

      // Real-time UI notification
      syncMediaStatus({
        businessProfileId: asset.businessProfileId,
        assetId: asset.id,
        platform: "messenger",
        identifier: fbPage.pageId,
        status: "SYNCED",
      });
    } catch (err: any) {
      logger.error("media.messenger.registration_failed", {
        assetId,
        pageId: fbPage.pageId,
        error: err.message,
      });
      await prisma.businessProfileMediaSync.upsert({
        where: {
          mediaId_platform_identifier: {
            mediaId: assetId,
            platform: "messenger",
            identifier: fbPage.pageId,
          },
        },
        update: { status: "FAILED", lastError: err.message },
        create: {
          mediaId: assetId,
          platform: "messenger",
          identifier: fbPage.pageId,
          externalMediaId: "FAILED",
          status: "FAILED",
          lastError: err.message,
        },
      });
    }
  }
}

/**
 * Resolves a named media asset to the correct delivery identifier for a channel.
 * IDENTITY AWARE: Returns the ID specific to the current PageID or PhoneID.
 */
export async function resolveAssetForChannel(
  assetName: string,
  businessProfileId: number,
  channel: "web" | "whatsapp" | "messenger",
  identifier?: string, // The PageID or PhoneNumberId
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
    return {
      url: asset.publicUrl,
      mediaType: asset.mediaType,
      mimeType: asset.mimeType,
    };
  }

  // 1. Precise Identity Lookup (Preferred)
  if (identifier) {
    const sync = await prisma.businessProfileMediaSync.findUnique({
      where: {
        mediaId_platform_identifier: {
          mediaId: asset.id,
          platform: channel,
          identifier: identifier,
        },
      },
    });

    if (sync && sync.status === "SYNCED") {
      return {
        mediaId: sync.externalMediaId,
        url: asset.publicUrl,
        mediaType: asset.mediaType,
        mimeType: asset.mimeType,
      };
    }
  }

  // 2. Legacy Fallback
  const legacyId =
    channel === "whatsapp"
      ? asset.whatsappMediaId
      : asset.messengerAttachmentId;

  return {
    mediaId: legacyId ?? undefined,
    url: asset.publicUrl,
    mediaType: asset.mediaType,
    mimeType: asset.mimeType,
  };
}

/**
 * Soft-deletes a media asset.
 * The R2 file and DB record are preserved for historical message integrity.
 */
export async function softDeleteAsset(
  assetId: number,
  userId: number,
): Promise<void> {
  const asset = await prisma.businessProfileMedia.findFirst({
    where: { id: assetId, userId },
  });
  if (!asset) throw new AppError("Asset not found or access denied", 404);

  await prisma.businessProfileMedia.update({
    where: { id: assetId },
    data: { isActive: false, deletedAt: new Date() },
  });
  logger.info("media.soft_deleted", { assetId, userId });
}

/**
 * Lists all active media assets for a business profile.
 */
export async function listMediaAssets(
  businessProfileId: number,
  userId: number,
) {
  return prisma.businessProfileMedia.findMany({
    where: { businessProfileId, userId, isActive: true, deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: {
      syncs: {
        orderBy: { updatedAt: "desc" },
      },
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
  if (!asset) throw new AppError("Asset not found or access denied", 404);

  const updateData: any = {};
  if (data.name) updateData.name = data.name.trim().substring(0, 100);
  if (data.instructions) {
    updateData.instructions = data.instructions
      .replace(/[<>{}\[\]\\]/g, "")
      .trim()
      .substring(0, 500);
  }

  return prisma.businessProfileMedia.update({
    where: { id: assetId },
    data: updateData,
  });
}
