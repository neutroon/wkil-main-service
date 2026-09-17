import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { metaExpressQueue } from "@modules/meta/core/meta.queue";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { executeCustomerTurn } from "@modules/ai-agent/customer/customerAgent.service";
import {
  applyCustomerDecision,
  classifyCustomerDeliveryError,
  type CustomerDeliveryAdapter,
} from "@modules/ai-agent/customer/customerDecision.service";
import type { CustomerChannel } from "@modules/ai-agent/customer/customerAgent.types";

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
  channel?: string | null;
};

/**
 * Removes only still-pending follow-up jobs for one conversation. A job can
 * become active between inspection and removal, so active work is never
 * cancelled or retried here; the follow-up eligibility checks remain its
 * safety boundary.
 */
export async function cancelConversationFollowUps(conversationId: number): Promise<number> {
  const [delayed, waiting] = await Promise.all([
    metaExpressQueue.getDelayed(),
    metaExpressQueue.getWaiting(),
  ]);
  const candidates = [...delayed, ...waiting].filter((job) =>
    job.name === "follow_up" &&
    job.data?.type === "follow_up" &&
    job.data?.payload?.conversationId === conversationId,
  );

  const removedJobIds: string[] = [];
  for (const job of candidates) {
    // BullMQ's job lists are snapshots. Re-check state immediately before
    // remove so a worker that has claimed the job is left untouched.
    if (await job.getState() === "active") continue;
    try {
      await job.remove();
      if (job.id != null) removedJobIds.push(String(job.id));
    } catch (error) {
      // A job can become active after getState(). That race is intentionally
      // non-destructive; eligibility checks make the active job harmless.
      logger.warn("follow_up.cancel_remove_failed", {
        conversationId,
        jobId: job.id == null ? null : String(job.id),
      });
    }
  }

  if (removedJobIds.length > 0) {
    logger.info("follow_up.cancelled", { conversationId, jobIds: removedJobIds });
  }
  return removedJobIds.length;
}

const DIRECT_CHANNELS = new Set(["web", "messenger", "whatsapp"]);
const DELIVERED_TRIGGER_STATUSES = new Set(["SENT", "DELIVERED", "READ"]);
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
              channel: conversation.channel,
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

function createFollowUpDeliveryAdapter(conversation: any, businessProfile: any): CustomerDeliveryAdapter {
  return async (message) => {
    try {
      return await deliverFollowUp(conversation, businessProfile, message.content);
    } catch (error) {
      throw classifyCustomerDeliveryError(error);
    }
  };
}

async function deliverFollowUp(conversation: any, businessProfile: any, text: string) {
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
    return { externalId: (result as any)?.message_id ?? null };
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
    return { externalId: (result as any)?.messages?.[0]?.id ?? null };
  }
}

export async function processFollowUpJob(payload: FollowUpJobPayload) {
    const conversation = await prisma.conversation.findFirst({
      where: { id: payload.conversationId, businessProfileId: payload.businessProfileId },
      include: { businessProfile: true },
    });
    if (!isFollowUpConversationEligible(conversation)) return;
    const trigger = await prisma.conversationMessage.findFirst({ where: { id: payload.triggerMessageId, conversationId: payload.conversationId }, select: { createdAt: true, status: true, role: true, origin: true, handoffCategory: true } });
    if (!isFollowUpTriggerEligible(trigger) || await hasNewerHumanOrCustomerMessage(payload.conversationId, trigger!.createdAt)) return;
    if (await customerOptedOut(payload.conversationId)) return;
    if (conversation!.channel === "whatsapp" && !(await isWhatsAppFreeFormWindowOpen(payload.conversationId))) return;
    const turn = await executeCustomerTurn({
      userId: conversation.businessProfile.userId,
      businessProfileId: payload.businessProfileId,
      conversationId: payload.conversationId,
      channel: conversation.channel as CustomerChannel,
      customerText: "",
      runMode: "follow_up",
      followUpIndex: payload.delayIndex,
      dedupeKey: `follow-up:${payload.conversationId}:${payload.triggerMessageId}:${payload.delayIndex}`,
    });

    // Generation can take seconds. Re-check human control and every delivery
    // guard at the last application boundary so an active job cannot send
    // after a handoff or newer customer/staff activity.
    const currentConversation = await prisma.conversation.findFirst({
      where: { id: payload.conversationId, businessProfileId: payload.businessProfileId },
      include: { businessProfile: true },
    });
    if (!isFollowUpConversationEligible(currentConversation)) return;
    const currentTrigger = await prisma.conversationMessage.findFirst({
      where: { id: payload.triggerMessageId, conversationId: payload.conversationId },
      select: { createdAt: true, status: true, role: true, origin: true, handoffCategory: true },
    });
    if (!isFollowUpTriggerEligible(currentTrigger)) return;
    if (await hasNewerHumanOrCustomerMessage(payload.conversationId, currentTrigger.createdAt)) return;
    if (await customerOptedOut(payload.conversationId)) return;
    if (currentConversation.channel === "whatsapp" && !(await isWhatsAppFreeFormWindowOpen(payload.conversationId))) return;

    await applyCustomerDecision({
      businessProfileId: payload.businessProfileId,
      conversationId: payload.conversationId,
      agentTurnId: turn.agentTurnId,
      decision: turn.decision,
      deliver: createFollowUpDeliveryAdapter(currentConversation, currentConversation.businessProfile),
      origin: "follow_up",
    });
  }
