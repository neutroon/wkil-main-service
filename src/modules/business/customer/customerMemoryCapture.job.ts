import prisma from "@config/prisma";
import { generateContent } from "@modules/ai-agent/gemini";
import { logger } from "@utils/logger";
import { updateCustomerFromSavedDetails } from "./customer.service";
import type { CustomerMemoryCaptureJob } from "@modules/meta/core/meta.queue";

const MEMORY_CONTEXT_LIMIT = 20;
const MAX_PROMPT_CHARS = 12_000;

type CustomerMemoryField = {
  key?: string;
  label?: string;
  description?: string;
};

type MemoryExtractionResult = {
  profileUpdates?: {
    name?: string;
    phone?: string;
    email?: string;
  };
  fieldUpdates?: Record<string, string | number | boolean>;
  notes?: string | null;
};

export async function processCustomerMemoryCaptureJob(
  job: CustomerMemoryCaptureJob,
): Promise<void> {
  if (!job.conversationId) return;

  const context = await loadMemoryContext(job);
  if (!context) {
    logger.info("customer.memory_capture.skipped", {
      businessProfileId: job.businessProfileId,
      conversationId: job.conversationId,
      reason: "missing_context",
    });
    return;
  }

  const extracted = await extractCustomerMemoryWithAi(job, context);
  if (!extracted) return;

  const details = normalizeExtractedDetails(extracted);
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

async function loadMemoryContext(job: CustomerMemoryCaptureJob) {
  const [businessProfile, conversation] = await Promise.all([
    prisma.businessProfile.findUnique({
      where: { id: job.businessProfileId },
      select: {
        name: true,
        identity: true,
        voice: true,
        tone: true,
        customerDetailsInstructions: true,
        customerMemoryFields: true,
      },
    }),
    prisma.conversation.findFirst({
      where: {
        id: job.conversationId,
        businessProfileId: job.businessProfileId,
      },
      select: {
        id: true,
        channel: true,
        customerPhone: true,
        customerName: true,
        customer: {
          select: {
            displayName: true,
            phone: true,
            email: true,
            notes: true,
            capturedFields: true,
          },
        },
        messages: {
          orderBy: { createdAt: "desc" },
          take: MEMORY_CONTEXT_LIMIT,
          select: {
            role: true,
            content: true,
            createdAt: true,
          },
        },
      },
    }),
  ]);

  if (!businessProfile || !conversation) return null;

  const messages = conversation.messages
    .reverse()
    .map((message) => ({
      role: message.role === "user" ? "customer" : "agent",
      text: normalizeText(message.content),
    }))
    .filter((message) => message.text);

  return {
    businessProfile,
    conversation: {
      id: conversation.id,
      channel: conversation.channel,
      customerPhone: conversation.customerPhone || job.customerPhone || null,
      customerName: conversation.customerName || null,
    },
    currentCustomer: conversation.customer
      ? {
          displayName: conversation.customer.displayName,
          phone: conversation.customer.phone,
          email: conversation.customer.email,
          notes: conversation.customer.notes,
          capturedFields: conversation.customer.capturedFields || {},
        }
      : null,
    messages:
      messages.length > 0
        ? messages
        : (job.recentTurns || []).map((turn) => ({
            role: turn.role === "user" ? "customer" : "agent",
            text: normalizeText(turn.text),
          })),
  };
}

async function extractCustomerMemoryWithAi(
  job: CustomerMemoryCaptureJob,
  context: NonNullable<Awaited<ReturnType<typeof loadMemoryContext>>>,
): Promise<MemoryExtractionResult | null> {
  const fields = normalizeMemoryFields(context.businessProfile.customerMemoryFields);
  const prompt = buildExtractionPrompt(job, context, fields);

  try {
    const { text } = await generateContent(
      prompt,
      "application/json",
      false,
      undefined,
      0,
    );
    return parseExtractionResult(text);
  } catch (error: any) {
    logger.warn("customer.memory_capture.ai_failed", {
      businessProfileId: job.businessProfileId,
      conversationId: job.conversationId,
      error: error?.message || String(error),
    });
    return null;
  }
}

function buildExtractionPrompt(
  job: CustomerMemoryCaptureJob,
  context: NonNullable<Awaited<ReturnType<typeof loadMemoryContext>>>,
  fields: CustomerMemoryField[],
): string {
  const payload = stringifyForPrompt(
    {
      business: {
        name: context.businessProfile.name,
        identity: context.businessProfile.identity,
        voice: context.businessProfile.voice,
        tone: context.businessProfile.tone,
      },
      memoryInstructions: context.businessProfile.customerDetailsInstructions,
      customFields: fields,
      conversation: context.conversation,
      currentCustomer: context.currentCustomer,
      latestCustomerMessage: job.latestUserText,
      recentMessages: context.messages,
    },
    MAX_PROMPT_CHARS,
  );

  return [
    "You extract local customer memory for a customer-support SaaS.",
    "Return JSON only. Do not include markdown.",
    "",
    "Goal:",
    "- Save only useful customer details that are explicitly supported by the conversation or existing customer profile.",
    "- Do not invent, infer weakly, or create placeholder values.",
    "- If there is nothing useful to save, return {}.",
    "- Prefer the configured custom field keys for fieldUpdates. Do not create unrelated field keys.",
    "- Use profileUpdates only for clearly stated customer name, phone, or email.",
    "- Use notes only for a concise durable customer request/preference/next step.",
    "",
    "Output shape:",
    "{",
    '  "profileUpdates": { "name": "string", "phone": "string", "email": "string" },',
    '  "fieldUpdates": { "configured_field_key": "string | number | boolean" },',
    '  "notes": "string"',
    "}",
    "",
    "Input JSON:",
    payload,
  ].join("\n");
}

function parseExtractionResult(text: string): MemoryExtractionResult | null {
  const cleaned = stripJsonFence(text).trim();
  if (!cleaned) return null;

  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as MemoryExtractionResult;
  } catch (error: any) {
    logger.warn("customer.memory_capture.invalid_ai_json", {
      error: error?.message || String(error),
    });
    return null;
  }
}

function normalizeExtractedDetails(result: MemoryExtractionResult) {
  const details: Record<string, unknown> = {};
  const profile = result.profileUpdates || {};

  const name = cleanString(profile.name);
  const phone = cleanString(profile.phone);
  const email = cleanString(profile.email);
  const notes = cleanString(result.notes);

  if (name) details.name = name;
  if (phone) details.phone = phone;
  if (email) details.email = email;

  if (
    result.fieldUpdates &&
    typeof result.fieldUpdates === "object" &&
    !Array.isArray(result.fieldUpdates)
  ) {
    for (const [key, value] of Object.entries(result.fieldUpdates)) {
      const cleanKey = cleanString(key);
      if (!cleanKey || value === null || value === undefined) continue;
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        details[cleanKey] = typeof value === "string" ? value.trim() : value;
      }
    }
  }

  if (notes) details.notes = notes;

  return details;
}

function normalizeMemoryFields(value: unknown): CustomerMemoryField[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 3)
    .map((field) => {
      if (!field || typeof field !== "object" || Array.isArray(field)) {
        return null;
      }
      const record = field as Record<string, unknown>;
      const key = cleanString(record.key);
      const label = cleanString(record.label);
      const description = cleanString(record.description);
      if (!key || !label) return null;
      return { key, label, description: description || undefined };
    })
    .filter(Boolean) as CustomerMemoryField[];
}

function stripJsonFence(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
}

function stringifyForPrompt(value: unknown, maxChars: number): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n...[truncated]`;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}
