import { AgentClient } from "@modules/ai-agent/client/agent.client";
import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { updateCustomerFromSavedDetails } from "./customer.service";
import {
  memoryExtractionSchema,
  type MemoryExtractionResult,
} from "./customerMemoryCapture.schemas";
import type { CustomerMemoryCaptureJob } from "@modules/meta/core/meta.queue";

const MEMORY_CONTEXT_LIMIT = 20;
const MAX_PROMPT_CHARS = 12_000;

type CustomerMemoryField = {
  key?: string;
  label?: string;
  description?: string;
};

export async function processCustomerMemoryCaptureJob(
  job: CustomerMemoryCaptureJob,
): Promise<void> {
  return AgentClient.runAgent({
    business_profile_id: job.businessProfileId,
    user_id: undefined,
    messages: [],
    stage: "fast",
  } as any) as any;
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
  // Memory-capture AI moved to the sibling agent-svc microservice in the
  // ai-agent cutover. The job entry point (processCustomerMemoryCaptureJob)
  // routes via AgentClient; this helper is preserved for the future re-enable.
  void job;
  void context;
  void normalizeMemoryFields;
  void buildExtractionPrompt;
  void memoryExtractionSchema;
  return null;
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

function normalizeExtractedDetails(result: MemoryExtractionResult) {
  const details: Record<string, unknown> = {};
  const profile = result.profileUpdates ?? { name: null, phone: null, email: null };

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
