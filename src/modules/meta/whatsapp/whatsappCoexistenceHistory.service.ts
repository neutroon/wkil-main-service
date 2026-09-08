import prisma from "@config/prisma";
import { upsertCustomerFromConversation } from "@modules/business/customer/customer.service";
import {
  type CoexistenceHistoryMessage,
  type WhatsappCoexistenceHistoryJob,
} from "./whatsappCoexistence.schemas";

export const WHATSAPP_COEXISTENCE_HISTORY_ORIGIN = "whatsapp_coexistence_history" as const;
const HISTORY_BATCH_SIZE = 100;

export type CoexistenceHistoryInput = WhatsappCoexistenceHistoryJob;

export type CoexistenceImportSummary = {
  processed: number;
  imported: number;
  duplicates: number;
  skipped: number;
  conversationIds: number[];
};

type UnknownRecord = Record<string, unknown>;

type HistoryDatabase = {
  conversation: {
    findFirst(args: unknown): Promise<any>;
    create(args: unknown): Promise<any>;
    updateMany(args: unknown): Promise<any>;
  };
  conversationMessage: {
    create(args: unknown): Promise<any>;
  };
};

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function sourceCreatedAt(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1_000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  if (typeof value !== "string" || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return sourceCreatedAt(numeric);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002",
  );
}

function normalizedParticipant(value: unknown): string {
  return String(value || "").replace(/\D/g, "");
}

function isBusinessMessage(message: UnknownRecord, threadId: string): boolean {
  const direction = firstString(message.direction, message.direction_type)?.toLowerCase();
  if (direction === "outbound" || direction === "sent" || direction === "business") return true;
  if (direction === "inbound" || direction === "received" || direction === "customer") return false;

  const from = firstString(message.from, message.sender, message.sender_id);
  if (!from) return false;
  const normalizedFrom = normalizedParticipant(from);
  const normalizedThread = normalizedParticipant(threadId);
  return normalizedFrom !== normalizedThread;
}

function mediaPayload(message: UnknownRecord): UnknownRecord {
  const type = firstString(message.type)?.toLowerCase();
  const typedPayload = type ? asRecord(message[type]) : {};
  const genericPayload = asRecord(message.media);
  return Object.keys(typedPayload).length > 0 ? typedPayload : genericPayload;
}

function mediaFields(message: UnknownRecord): {
  mediaId: string | null;
  mediaMetadata: UnknownRecord | null;
} {
  const type = firstString(message.type)?.toLowerCase();
  if (!type || type === "text") return { mediaId: null, mediaMetadata: null };

  const payload = mediaPayload(message);
  const mediaId = firstString(payload.id, payload.media_id, message.mediaId, message.media_id);
  const metadata: UnknownRecord = {};
  if (typeof payload.mime_type === "string") metadata.mimeType = payload.mime_type;
  if (typeof payload.mimeType === "string") metadata.mimeType = payload.mimeType;
  if (typeof payload.sha256 === "string") metadata.sha256 = payload.sha256;
  if (typeof payload.duration === "number") metadata.duration = payload.duration;
  if (typeof payload.filename === "string") metadata.filename = payload.filename;

  if (!mediaId) {
    metadata.placeholder = true;
    metadata.placeholderReason = "media_id_unavailable";
  }

  return {
    mediaId,
    mediaMetadata: metadata,
  };
}

function messageContent(message: UnknownRecord): string {
  const type = firstString(message.type)?.toLowerCase();
  const typedPayload = type ? asRecord(message[type]) : {};
  return (
    firstString(
      asRecord(message.text).body,
      typedPayload.caption,
      typedPayload.filename,
      message.body,
      message.caption,
    ) || ""
  );
}

function messageStatus(message: UnknownRecord): "READ" | "SENT" {
  const status = firstString(message.status, message.message_status, message.delivery_status)?.toLowerCase();
  return status === "read" ? "READ" : "SENT";
}

function latestTimestamp(messages: Array<{ createdAt: Date }>): Date {
  return messages.reduce(
    (latest, message) => (message.createdAt > latest ? message.createdAt : latest),
    messages[0]!.createdAt,
  );
}

function earliestTimestamp(messages: Array<{ createdAt: Date }>): Date {
  return messages.reduce(
    (earliest, message) => (message.createdAt < earliest ? message.createdAt : earliest),
    messages[0]!.createdAt,
  );
}

function historyMessages(
  thread: UnknownRecord,
  summary: CoexistenceImportSummary,
): Array<{ raw: UnknownRecord; createdAt: Date }> {
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const normalized: Array<{ raw: UnknownRecord; createdAt: Date }> = [];

  for (const value of messages) {
    const message = asRecord(value) as CoexistenceHistoryMessage & UnknownRecord;
    const createdAt = sourceCreatedAt(message.timestamp);
    if (!createdAt || !firstString(message.id)) {
      summary.skipped += 1;
      continue;
    }
    summary.processed += 1;
    normalized.push({ raw: message, createdAt });
  }

  return normalized;
}

async function importBatch(
  input: CoexistenceHistoryInput,
  businessProfileId: number,
  batch: Array<{ thread: UnknownRecord; raw: UnknownRecord; createdAt: Date; threadIndex: number }>,
  summary: CoexistenceImportSummary,
  conversationIds: Set<number>,
  conversationCache: Map<number, { id: number; thread: UnknownRecord }>,
  threadStartedAt: Map<number, Date>,
  threadActivityAt: Map<number, Date>,
  seenExternalIds: Set<string>,
) {
  await prisma.$transaction(async (transaction) => {
    const db = transaction as unknown as HistoryDatabase;

    for (const item of batch) {
      const threadId = firstString(item.thread.id);
      if (!threadId) {
        summary.skipped += 1;
        continue;
      }

      let conversation = conversationCache.get(item.threadIndex);
      if (!conversation) {
        const existing = await db.conversation.findFirst({
          where: {
            businessProfileId,
            pageId: input.phoneNumberId,
            senderId: threadId,
            channel: "whatsapp",
          },
          select: { id: true, customerId: true, updatedAt: true },
        });
        const customer = await upsertCustomerFromConversation({
          businessProfileId,
          channel: "whatsapp",
          senderId: threadId,
          customerPhone: threadId,
          customerName: firstString(
            item.thread.customerName,
            item.thread.customer_name,
            asRecord(item.thread.contact).name,
            asRecord(item.thread.profile).name,
          ),
          updateInteraction: false,
          activityAt: threadActivityAt.get(item.threadIndex),
          db: transaction,
        });

        if (existing && !existing.customerId) {
          await db.conversation.updateMany({
            where: { id: existing.id },
            data: { customerId: customer.id, updatedAt: existing.updatedAt },
          });
        }

        const created = existing || (await db.conversation.create({
          data: {
            pageId: input.phoneNumberId,
            senderId: threadId,
            businessProfileId,
            customerId: customer.id,
            channel: "whatsapp",
            customerPhone: threadId,
            customerName: firstString(
              item.thread.customerName,
              item.thread.customer_name,
              asRecord(item.thread.contact).name,
              asRecord(item.thread.profile).name,
            ),
            createdAt: threadStartedAt.get(item.threadIndex),
            updatedAt: threadActivityAt.get(item.threadIndex),
          },
        }));

        conversation = { id: created.id, thread: item.thread };
        conversationCache.set(item.threadIndex, conversation);
        conversationIds.add(created.id);
      }

      const externalId = firstString(item.raw.id);
      if (!externalId || seenExternalIds.has(externalId)) {
        summary.duplicates += 1;
        continue;
      }
      seenExternalIds.add(externalId);

      const media = mediaFields(item.raw);
      try {
        await db.conversationMessage.create({
          data: {
            conversationId: conversation.id,
            role: isBusinessMessage(item.raw, threadId) ? "agent" : "user",
            content: messageContent(item.raw),
            type: firstString(item.raw.type) || "text",
            mediaId: media.mediaId,
            mediaMetadata: media.mediaMetadata,
            externalId,
            status: messageStatus(item.raw),
            origin: WHATSAPP_COEXISTENCE_HISTORY_ORIGIN,
            createdAt: item.createdAt,
          },
        });
        summary.imported += 1;
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          summary.duplicates += 1;
          continue;
        }
        throw error;
      }
    }
  });
}

export async function importCoexistenceHistoryChunk(
  input: CoexistenceHistoryInput,
): Promise<CoexistenceImportSummary> {
  const account = await prisma.whatsAppAccount.findFirst({
    where: {
      phoneNumberId: input.phoneNumberId,
      isActive: true,
      businessProfileId: { not: null },
    },
    select: { businessProfileId: true },
  });
  if (!account?.businessProfileId) {
    throw new Error("WhatsApp account is not linked to a business profile");
  }
  const businessProfileId = account.businessProfileId;

  const summary: CoexistenceImportSummary = {
    processed: 0,
    imported: 0,
    duplicates: 0,
    skipped: 0,
    conversationIds: [],
  };
  const conversationIds = new Set<number>();
  const conversationCache = new Map<number, { id: number; thread: UnknownRecord }>();
  const threadStartedAt = new Map<number, Date>();
  const threadActivityAt = new Map<number, Date>();
  const seenExternalIds = new Set<string>();
  const flattened: Array<{ thread: UnknownRecord; raw: UnknownRecord; createdAt: Date; threadIndex: number }> = [];

  input.historyChunk.threads.forEach((value, threadIndex) => {
    const thread = asRecord(value);
    const messages = historyMessages(thread, summary);
    if (messages.length > 0) {
      threadStartedAt.set(threadIndex, earliestTimestamp(messages));
      threadActivityAt.set(threadIndex, latestTimestamp(messages));
    }
    for (const message of messages) {
      flattened.push({ ...message, thread, threadIndex });
    }
  });

  for (let index = 0; index < flattened.length; index += HISTORY_BATCH_SIZE) {
    await importBatch(
      input,
      businessProfileId,
      flattened.slice(index, index + HISTORY_BATCH_SIZE),
      summary,
      conversationIds,
      conversationCache,
      threadStartedAt,
      threadActivityAt,
      seenExternalIds,
    );
  }

  summary.conversationIds = Array.from(conversationIds);
  return summary;
}
