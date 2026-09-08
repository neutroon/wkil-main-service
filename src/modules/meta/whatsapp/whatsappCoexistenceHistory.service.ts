import prisma from "@config/prisma";
import { Prisma } from "@prisma/client";
import { upsertCustomerFromConversation } from "@modules/business/customer/customer.service";
import {
  type CoexistenceHistoryMessage,
  type WhatsappCoexistenceHistoryJob,
} from "./whatsappCoexistence.schemas";
import {
  getConversationIdentityLockKey,
  lockConversationIdentity,
} from "@modules/meta/core/conversation.service";

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
    findMany(args: unknown): Promise<Array<{ externalId: string | null }>>;
    createMany(args: unknown): Promise<{ count: number }>;
  };
  $executeRaw(query: Prisma.Sql): Promise<number>;
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
  const text = value.trim();
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return sourceCreatedAt(numeric);
  const timezoneLessIso =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const date = new Date(timezoneLessIso.test(text) && !hasTimezone ? `${text}Z` : text);
  return Number.isNaN(date.getTime()) ? null : date;
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
    const pendingMessages: Array<{ externalId: string; data: Record<string, unknown> }> = [];
    const lockTargets = new Map<string, string>();

    for (const item of batch) {
      const threadId = firstString(item.thread.id);
      if (!threadId) continue;
      lockTargets.set(
        getConversationIdentityLockKey(
          input.phoneNumberId,
          threadId,
          businessProfileId,
          "whatsapp",
        ),
        threadId,
      );
    }

    for (const [lockKey, threadId] of Array.from(lockTargets.entries()).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      await lockConversationIdentity(
        db,
        input.phoneNumberId,
        threadId,
        businessProfileId,
        "whatsapp",
      );
    }

    for (const item of batch) {
      const threadId = firstString(item.thread.id);
      if (!threadId) {
        summary.skipped += 1;
        continue;
      }

      const externalId = firstString(item.raw.id);
      if (!externalId || seenExternalIds.has(externalId)) {
        summary.duplicates += 1;
        continue;
      }
      seenExternalIds.add(externalId);

      let conversation = conversationCache.get(item.threadIndex);
      if (!conversation) {
        const existing = await db.conversation.findFirst({
          where: {
            businessProfileId,
            pageId: input.phoneNumberId,
            senderId: threadId,
            channel: "whatsapp",
          },
          orderBy: { updatedAt: "desc" },
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

        const activityAt = threadActivityAt.get(item.threadIndex);
        if (existing && !existing.customerId && activityAt) {
          await db.conversation.updateMany({
            where: {
              id: existing.id,
              customerId: null,
              updatedAt: { lte: activityAt },
            },
            data: { customerId: customer.id, updatedAt: activityAt },
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
            readAt: threadActivityAt.get(item.threadIndex),
            createdAt: threadStartedAt.get(item.threadIndex),
            updatedAt: threadActivityAt.get(item.threadIndex),
          },
        }));

        conversation = { id: created.id, thread: item.thread };
        conversationCache.set(item.threadIndex, conversation);
        conversationIds.add(created.id);
      }

      const media = mediaFields(item.raw);
      pendingMessages.push({
        externalId,
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
    }

    if (pendingMessages.length === 0) return;

    const existingMessages = await db.conversationMessage.findMany({
      where: { externalId: { in: pendingMessages.map((message) => message.externalId) } },
      select: { externalId: true },
    });
    const existingExternalIds = new Set(
      existingMessages
        .map((message) => message.externalId)
        .filter((externalId): externalId is string => Boolean(externalId)),
    );
    const messagesToInsert = pendingMessages.filter(
      (message) => !existingExternalIds.has(message.externalId),
    );
    summary.duplicates += existingExternalIds.size;

    if (messagesToInsert.length === 0) return;

    const inserted = await db.conversationMessage.createMany({
      data: messagesToInsert.map((message) => message.data),
      skipDuplicates: true,
    });
    const importedCount = Number.isInteger(inserted.count) ? inserted.count : 0;
    summary.imported += importedCount;
    summary.duplicates += messagesToInsert.length - importedCount;
  });
}

export async function importCoexistenceHistoryChunk(
  input: CoexistenceHistoryInput,
): Promise<CoexistenceImportSummary> {
  const account = await prisma.whatsAppAccount.findFirst({
    where: {
      phoneNumberId: input.phoneNumberId,
      wabaId: input.wabaId,
      connectionMode: "COEXISTENCE",
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
