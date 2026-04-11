import axios from "axios";
import FormData from "form-data";
import { logger } from "../../utils/logger";

/**
 * Uploads a file to Meta's Media API for WhatsApp.
 * Returns the media ID.
 */
export async function uploadWhatsAppMedia(
  phoneNumberId: string,
  accessToken: string,
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string
): Promise<string> {
  try {
    const form = new FormData();
    form.append("file", fileBuffer, { filename: fileName, contentType: mimeType });
    form.append("type", mimeType.split("/")[0]);
    form.append("messaging_product", "whatsapp");

    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${phoneNumberId}/media`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    return response.data.id;
  } catch (error: any) {
    const msg = error.response?.data?.error?.message || error.message;
    logger.error("meta_upload.whatsapp.failed", { error: msg });
    throw new Error(`WhatsApp upload failed: ${msg}`);
  }
}

/**
 * Uploads a file to Meta's Media API for Messenger.
 * Returns the attachment_id.
 */
export async function uploadMessengerMedia(
  pageId: string,
  accessToken: string,
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string
): Promise<string> {
  try {
    const form = new FormData();
    form.append("message", JSON.stringify({
      attachment: {
        type: mimeType.startsWith("image") ? "image" : mimeType.startsWith("video") ? "video" : "file",
        payload: { is_reusable: true }
      }
    }));
    form.append("filedata", fileBuffer, { filename: fileName, contentType: mimeType });

    const response = await axios.post(
      `https://graph.facebook.com/v21.0/${pageId}/message_attachments`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    return response.data.attachment_id;
  } catch (error: any) {
    const msg = error.response?.data?.error?.message || error.message;
    logger.error("meta_upload.messenger.failed", { error: msg });
    throw new Error(`Messenger upload failed: ${msg}`);
  }
}
