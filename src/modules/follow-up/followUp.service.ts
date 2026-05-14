import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { generateContent } from "@modules/ai-agent/gemini";
import { metaExpressQueue } from "@modules/meta/core/meta.queue";
import { saveMessage } from "@modules/meta/core/conversation.service";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";

type FollowUpDelayUnit = "MINUTES" | "HOURS" | "DAYS";

type FollowUpDelay = {
  amount: number;
  unit: FollowUpDelayUnit;
};

export type FollowUpJobPayload = {
  conversationId: number;
  businessProfileId: number;
  triggerMessageId: number;
  delayIndex: number;
};

const DIRECT_CHANNELS = new Set(["web", "messenger", "whatsapp"]);
const DELIVERED_TRIGGER_STATUSES = new Set(["SENT", "DELIVERED", "READ"]);
const MAX_FOLLOW_UP_CHARS = 700;
const FOLLOW_UP_TIMEOUT_MS = 8_000;
const WHATSAPP_FREE_FORM_WINDOW_MS = 23 * 60 * 60 * 1000;
const OPT_OUT_PATTERN =
  /\b(stop|unsubscribe|do not message|don't message|لا تراسل|وقف الرسائل|الغاء الاشتراك|إلغاء الاشتراك)\b/i;

function isFollowUpConversationEligible<T extends {
  businessProfile: {
    followUpEnabled: boolean;
  };
  channel?: string | null;
  status: string;
  aiEnabled: boolean;
} | null | undefined>(
  conversation: T,
): conversation is NonNullable<T> {
  if (!conversation?.businessProfile.followUpEnabled) return false;
  if (!DIRECT_CHANNELS.has(conversation.channel || "")) return false;
  if (conversation.status !== "OPEN" || conversation.aiEnabled === false) return false;
  return true;
}

function isFollowUpTriggerEligible<T extends {
  role: string;
  origin?: string | null;
  status: string;
  handoffCategory?: string | null;
} | null | undefined>(trigger: T): trigger is NonNullable<T> {
  if (!trigger || trigger.role !== "model") return false;
  if (trigger.origin === "follow_up") return false;
  if (!DELIVERED_TRIGGER_STATUSES.has(trigger.status)) return false;
  if (trigger.handoffCategory) return false;
  return true;
}

function parseFollowUpDelays(value: unknown): FollowUpDelay[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((delay) => {
      const amount = Number((delay as any)?.amount);
      const unit = (delay as any)?.unit;
      if (!Number.isInteger(amount) || amount <= 0) return null;
      if (!["MINUTES", "HOURS", "DAYS"].includes(unit)) return null;
      return { amount, unit } as FollowUpDelay;
    })
    .filter(Boolean) as FollowUpDelay[];
}

function delayToMs(delay: FollowUpDelay): number {
  const unitMs =
    delay.unit === "DAYS"
      ? 24 * 60 * 60 * 1000
      : delay.unit === "HOURS"
        ? 60 * 60 * 1000
        : 60 * 1000;

  return delay.amount * unitMs;
}

function cleanAiText(text: string): string {
  const cleaned = text
    .replace(/^```(?:text|json)?/i, "")
    .replace(/```$/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && typeof parsed.content === "string") {
      return parsed.content.trim();
    }
  } catch {
    // Plain text is expected.
  }

  return cleaned.slice(0, MAX_FOLLOW_UP_CHARS).trim();
}

function buildFollowUpPrompt(params: {
  businessProfile: any;
  conversation: any;
  history: Array<{ role: string; content: string; createdAt: Date }>;
  delayIndex: number;
}): string {
  const { businessProfile, conversation, history, delayIndex } = params;
  const customInstructions =
    businessProfile.followUpMode === "CUSTOM" && businessProfile.followUpInstructions
      ? businessProfile.followUpInstructions
      : "";

  const historyText = history
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`.trim())
    .join("\n")
    .slice(-5000);

  return [
    "<follow_up_task>",
    "Write ONE customer-facing follow-up message for an existing support/sales chat.",
    "Output ONLY the message text. Do not output JSON or markdown.",
    "The message must be generated from the conversation context, not from a fixed template.",
    "",
    "<business_voice>",
    `Business: ${businessProfile.name}`,
    `Identity: ${businessProfile.identity}`,
    `Voice / dialect: ${businessProfile.voice}`,
    `Tone: ${businessProfile.tone}`,
    `Target audience: ${businessProfile.targetAudience}`,
    "</business_voice>",
    "",
    "<follow_up_context>",
    `Channel: ${conversation.channel || "unknown"}`,
    `Follow-up number: ${delayIndex + 1}`,
    customInstructions ? `Admin guidance: ${customInstructions}` : "Mode: AI decides the best follow-up from chat context.",
    "</follow_up_context>",
    "",
    "<hard_rules>",
    "- Do not mention APIs, webhooks, CRM, jobs, databases, queues, or internal systems.",
    "- Do not invent prices, policies, availability, delivery dates, appointments, identifiers, or contact details.",
    "- Do not claim anything was confirmed, booked, saved, submitted, delivered, or completed unless the chat history explicitly says so.",
    "- If the customer was waiting for a human or verification, politely continue that thread without promising an exact time.",
    "- If the last customer message already closed the conversation, output an empty string.",
    "- Keep it short: usually 1-2 sentences, plain text only.",
    "</hard_rules>",
    "",
    "<conversation_history>",
    historyText,
    "</conversation_history>",
    "</follow_up_task>",
  ].join("\n");
}

async function generateFollowUpText(params: {
  businessProfile: any;
  conversation: any;
  history: Array<{ role: string; content: string; createdAt: Date }>;
  delayIndex: number;
}): Promise<string> {
  const prompt = buildFollowUpPrompt(params);
  const result = await Promise.race([
    generateContent(prompt, "text/plain", false, undefined, 0.3),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("FOLLOW_UP_AI_TIMEOUT")), FOLLOW_UP_TIMEOUT_MS),
    ),
  ]);

  return cleanAiText(result.text || "");
}

export async function scheduleConversationFollowUps(params: {
  conversationId: number;
  businessProfileId: number;
  triggerMessageId: number;
}) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: params.conversationId },
    include: { businessProfile: true },
  });

  if (!isFollowUpConversationEligible(conversation)) {
    logger.info("follow_up.schedule_skipped.ineligible_conversation", {
      conversationId: params.conversationId,
    });
    return;
  }

  const trigger = await prisma.conversationMessage.findUnique({
    where: { id: params.triggerMessageId },
    select: { id: true, role: true, status: true, origin: true, handoffCategory: true },
  });

  if (!isFollowUpTriggerEligible(trigger)) {
    logger.info("follow_up.schedule_skipped.ineligible_trigger", {
      conversationId: params.conversationId,
      triggerMessageId: params.triggerMessageId,
      status: (trigger as any)?.status,
      role: (trigger as any)?.role,
      origin: (trigger as any)?.origin,
      handoffCategory: (trigger as any)?.handoffCategory,
    });
    return;
  }

  const delays = parseFollowUpDelays(conversation.businessProfile.followUpDelays);
  if (delays.length === 0) {
    logger.info("follow_up.schedule_skipped.no_delays", {
      conversationId: params.conversationId,
    });
    return;
  }

  try {
    await Promise.all(
      delays.map((delay, delayIndex) =>
        metaExpressQueue.add(
          "follow_up",
          {
            type: "follow_up",
            payload: {
              conversationId: params.conversationId,
              businessProfileId: params.businessProfileId,
              triggerMessageId: params.triggerMessageId,
              delayIndex,
            } satisfies FollowUpJobPayload,
          },
          {
            delay: delayToMs(delay),
            jobId: `followup-${params.conversationId}-${params.triggerMessageId}-${delayIndex}`,
            attempts: 1,
          },
        ),
      ),
    );
  } catch (error: any) {
    logger.error("follow_up.schedule_failed", {
      conversationId: params.conversationId,
      triggerMessageId: params.triggerMessageId,
      error: error?.message || String(error),
    });
    return;
  }

  logger.info("follow_up.scheduled", {
    conversationId: params.conversationId,
    triggerMessageId: params.triggerMessageId,
    count: delays.length,
  });
}

async function hasNewerHumanOrCustomerMessage(conversationId: number, after: Date) {
  const count = await prisma.conversationMessage.count({
    where: {
      conversationId,
      createdAt: { gt: after },
      OR: [{ role: "user" }, { role: "agent" }],
    },
  });
  return count > 0;
}

async function customerOptedOut(conversationId: number) {
  const recentUserMessages = await prisma.conversationMessage.findMany({
    where: { conversationId, role: "user" },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { content: true },
  });

  return recentUserMessages.some((m) => OPT_OUT_PATTERN.test(m.content || ""));
}

async function isWhatsAppFreeFormWindowOpen(conversationId: number) {
  const latestCustomerMessage = await prisma.conversationMessage.findFirst({
    where: { conversationId, role: "user" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  if (!latestCustomerMessage) return false;
  return Date.now() - latestCustomerMessage.createdAt.getTime() < WHATSAPP_FREE_FORM_WINDOW_MS;
}

async function deliverFollowUp(conversation: any, businessProfile: any, text: string, messageId: number) {
  if (conversation.channel === "web") return;

  if (conversation.channel === "messenger") {
    const page = await prisma.facebookPage.findFirst({
      where: {
        pageId: conversation.pageId,
        businessProfileId: businessProfile.id,
        isActive: true,
      },
      select: { pageAccessToken: true },
    });
    if (!page) throw new Error("FOLLOW_UP_MESSENGER_PAGE_NOT_FOUND");

    const { sendMessengerReply } = await import("@modules/meta/messenger/messenger.service");
    const token = decryptFacebookSecret(page.pageAccessToken);
    const result = await sendMessengerReply(conversation.senderId, text, token);
    const externalId = (result as any)?.message_id;
    if (externalId) {
      await prisma.conversationMessage.update({
        where: { id: messageId },
        data: { externalId },
      });
    }
    return;
  }

  if (conversation.channel === "whatsapp") {
    const account = await prisma.whatsAppAccount.findFirst({
      where: {
        phoneNumberId: conversation.pageId,
        businessProfileId: businessProfile.id,
        isActive: true,
      },
      select: { accessToken: true, phoneNumberId: true },
    });
    if (!account) throw new Error("FOLLOW_UP_WHATSAPP_ACCOUNT_NOT_FOUND");

    const { sendWhatsAppReply } = await import("@modules/meta/whatsapp/whatsapp.service");
    const token = decryptFacebookSecret(account.accessToken);
    const result = await sendWhatsAppReply(
      conversation.senderId,
      text,
      account.phoneNumberId,
      token,
    );
    const externalId = (result as any)?.messages?.[0]?.id;
    if (externalId) {
      await prisma.conversationMessage.update({
        where: { id: messageId },
        data: { externalId },
      });
    }
  }
}

export async function processFollowUpJob(payload: FollowUpJobPayload) {
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: payload.conversationId,
      businessProfileId: payload.businessProfileId,
    },
    include: {
      businessProfile: true,
      messages: {
        orderBy: { createdAt: "asc" },
        take: 30,
        select: { role: true, content: true, createdAt: true },
      },
    },
  });

  if (!isFollowUpConversationEligible(conversation)) {
    logger.info("follow_up.skipped.ineligible_conversation", {
      conversationId: payload.conversationId,
    });
    return;
  }
  if (conversation.channel === "whatsapp" && !(await isWhatsAppFreeFormWindowOpen(conversation.id))) {
    logger.info("follow_up.skipped.whatsapp_window_closed", {
      conversationId: conversation.id,
    });
    return;
  }
  if (await customerOptedOut(conversation.id)) {
    logger.info("follow_up.skipped.customer_opted_out", {
      conversationId: conversation.id,
    });
    return;
  }

  const trigger = await prisma.conversationMessage.findUnique({
    where: { id: payload.triggerMessageId },
    select: { createdAt: true, status: true, role: true, origin: true, handoffCategory: true },
  });

  if (!isFollowUpTriggerEligible(trigger)) {
    logger.info("follow_up.skipped.ineligible_trigger", {
      conversationId: conversation.id,
      triggerMessageId: payload.triggerMessageId,
      status: (trigger as any)?.status,
      role: (trigger as any)?.role,
      origin: (trigger as any)?.origin,
      handoffCategory: (trigger as any)?.handoffCategory,
    });
    return;
  }
  if (await hasNewerHumanOrCustomerMessage(conversation.id, trigger.createdAt)) {
    logger.info("follow_up.skipped.newer_human_or_customer_message", {
      conversationId: conversation.id,
      triggerMessageId: payload.triggerMessageId,
    });
    return;
  }

  const text = await generateFollowUpText({
    businessProfile: conversation.businessProfile,
    conversation,
    history: conversation.messages,
    delayIndex: payload.delayIndex,
  });

  if (!text) return;

  const saved = await saveMessage(conversation.id, "model", text, {
    status: "SENT",
    origin: "follow_up",
  });

  try {
    await deliverFollowUp(conversation, conversation.businessProfile, text, saved.id);
    logger.info("follow_up.sent", {
      conversationId: conversation.id,
      messageId: saved.id,
      channel: conversation.channel,
    });
  } catch (error: any) {
    await prisma.conversationMessage.update({
      where: { id: saved.id },
      data: { status: "FAILED", aiReasoning: error?.message || String(error) },
    });
    throw error;
  }
}
