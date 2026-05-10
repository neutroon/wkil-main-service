import { logger } from "@utils/logger";
import { updateCustomerFromSavedDetails } from "./customer.service";
import type { CustomerMemoryCaptureJob } from "@modules/meta/core/meta.queue";

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/;

export async function processCustomerMemoryCaptureJob(
  job: CustomerMemoryCaptureJob,
): Promise<void> {
  if (!job.conversationId) return;

  const details = extractCustomerMemoryDetails(job);
  if (Object.keys(details).length === 0) {
    logger.info("customer.memory_capture.skipped", {
      businessProfileId: job.businessProfileId,
      conversationId: job.conversationId,
      reason: "no_useful_details",
    });
    return;
  }

  await updateCustomerFromSavedDetails({
    businessProfileId: job.businessProfileId,
    conversationId: job.conversationId,
    details,
  });

  logger.info("customer.memory_capture.saved", {
    businessProfileId: job.businessProfileId,
    conversationId: job.conversationId,
    fields: Object.keys(details),
  });
}

function extractCustomerMemoryDetails(
  job: CustomerMemoryCaptureJob,
): Record<string, unknown> {
  const latest = normalizeText(job.latestUserText);
  const details: Record<string, unknown> = {};

  const phone =
    cleanString(job.customerPhone) || cleanString(latest.match(PHONE_RE)?.[0]);
  if (phone) details.phone = phone;

  const email = cleanString(latest.match(EMAIL_RE)?.[0]);
  if (email) details.email = email;

  const note = buildUsefulNote(latest, job.recentTurns || []);
  if (note) details.notes = note;

  return details;
}

function buildUsefulNote(
  latestUserText: string,
  recentTurns: Array<{ role: "user" | "model"; text: string }>,
): string | null {
  if (!isUsefulCustomerMemory(latestUserText)) return null;

  const previousUserContext = recentTurns
    .filter((turn) => turn.role === "user")
    .map((turn) => normalizeText(turn.text))
    .filter((text) => text && text !== latestUserText)
    .slice(-2);

  const contextPrefix =
    previousUserContext.length > 0
      ? `سياق سابق: ${previousUserContext.join(" / ")}. `
      : "";

  return `${contextPrefix}آخر طلب: ${latestUserText}`.slice(0, 500);
}

function isUsefulCustomerMemory(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized || normalized.length < 3) return false;
  if (/^[؟?!.،,\s]+$/.test(normalized)) return false;

  const simpleNonMemory = new Set([
    "hi",
    "hello",
    "hey",
    "thanks",
    "thank you",
    "ok",
    "okay",
    "جميل",
    "تمام",
    "شكرا",
    "شكرًا",
    "السلام عليكم",
    "سلام عليكم",
    "وعليكم السلام",
    "مرحبا",
    "اهلا",
    "أهلا",
  ]);
  if (simpleNonMemory.has(normalized.toLowerCase())) return false;

  return /[\p{L}\p{N}]/u.test(normalized);
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}
