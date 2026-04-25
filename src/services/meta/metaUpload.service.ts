import axios from "axios";

import { logger } from "../../utils/logger";
import { AppError } from "../../middlewares/errorHandler.middleware";

/**
 * Upload a media file to WhatsApp Cloud API.
 * Returns the media ID.
 */
export async function uploadWhatsAppMedia(
  phoneNumberId: string,
  accessToken: string,
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<string> {
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(fileBuffer)], { type: mimeType });
  formData.append("file", blob, fileName);
  formData.append("messaging_product", "whatsapp");
  formData.append("type", mimeType);

  const response = await fetch(
    `https://graph.facebook.com/v25.0/${phoneNumberId}/media`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: formData,
    },
  );

  if (!response.ok) {
    const errorData = await response.json();
    const msg = errorData.error?.message || "Unknown error";
    throw new AppError(`WhatsApp upload failed: ${msg}`, 502);
  }

  const data = (await response.json()) as { id: string };
  return data.id;
}

/**
 * Upload a media file to Messenger API.
 * Returns the attachment_id.
 */
export async function uploadMessengerMedia(
  pageId: string,
  pageAccessToken: string,
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
): Promise<string> {
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(fileBuffer)], { type: mimeType });

  // Messenger requires a JSON payload + the file in a single multipart request
  formData.append(
    "message",
    JSON.stringify({
      attachment: {
        type: mimeType.startsWith("image")
          ? "image"
          : mimeType.startsWith("video")
            ? "video"
            : mimeType.startsWith("audio")
              ? "audio"
              : "file",
        payload: { is_reusable: true },
      },
    }),
  );
  formData.append("filedata", blob, fileName);

  const response = await fetch(
    `https://graph.facebook.com/v25.0/me/message_attachments?access_token=${pageAccessToken}`,
    {
      method: "POST",
      body: formData,
    },
  );

  if (!response.ok) {
    const errorData = await response.json();
    const msg = errorData.error?.message || "Unknown error";
    throw new AppError(`Messenger upload failed: ${msg}`, 502);
  }

  const data = (await response.json()) as { attachment_id: string };
  return data.attachment_id;
}
