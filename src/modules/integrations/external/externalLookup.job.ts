import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { executeExternalQuery } from "./externalData.service";
import {
  getConversationHistory,
  saveMessage,
} from "@modules/meta/core/conversation.service";
import {
  historyToLlmTurns,
  toPromptMessages,
} from "@modules/ai-agent/chat/conversationTurns";
import { computeBusinessChatReply } from "@modules/ai-agent/chat/businessChatReply.service";
import { initialCustomerReplyStatus } from "@modules/ai-agent/chat/deliveryPolicy";
import {
  markIntegrationActionRunFailed,
  markIntegrationActionRunRunning,
  markIntegrationActionRunSkipped,
  markIntegrationActionRunSucceeded,
} from "./integrationActionRun.service";

export type IntegrationActionTrigger =
  | "CHAT_REQUESTED"
  | "CUSTOMER_DETAILS_SAVED"
  | "HANDOFF_CREATED"
  | "CONVERSATION_RESOLVED"
  | "FOLLOW_UP_DUE";

export type IntegrationActionJob = {
  businessProfileId: number;
  trigger: IntegrationActionTrigger;
  sourceId: number;
  actionRunId?: number | null;
  conversationId?: number | null;
  customerId?: number | null;
  toolName?: string;
  args?: Record<string, any>;
  customerPhone?: string;
  latestUserText?: string;
  historyText?: string;
};

export async function processIntegrationActionJob(
  job: IntegrationActionJob,
): Promise<void> {
  await markIntegrationActionRunRunning(job.actionRunId);

  const source = await prisma.externalDataSource.findFirst({
    where: {
      id: job.sourceId,
      businessProfileId: job.businessProfileId,
      isActive: true,
      trigger: job.trigger,
    },
  });

  if (!source) {
    await markIntegrationActionRunSkipped({
      id: job.actionRunId,
      reason: "source_missing_or_inactive",
    });
    logger.warn("integration_action.job.source_missing", {
      businessProfileId: job.businessProfileId,
      sourceId: job.sourceId,
      trigger: job.trigger,
    });
    return;
  }

  if (job.trigger !== "CHAT_REQUESTED") {
    let envelope: Awaited<ReturnType<typeof executeExternalQuery>>;
    try {
      const args = await buildBackgroundActionArgs(job);
      envelope = await executeExternalQuery(
        job.businessProfileId,
        job.sourceId,
        args,
        {
          customerPhone: job.customerPhone,
          conversationId: job.conversationId ?? undefined,
          latestUserText: job.latestUserText,
          historyText: job.historyText,
        },
      );
    } catch (error: any) {
      await markIntegrationActionRunFailed({
        id: job.actionRunId,
        reason: error?.message || "integration_action_failed",
      });
      throw error;
    }

    logger.info("integration_action.job.background_completed", {
      businessProfileId: job.businessProfileId,
      sourceId: job.sourceId,
      trigger: job.trigger,
      customerId: job.customerId,
      conversationId: job.conversationId,
      verification: envelope.verification,
      reason: envelope.reason,
    });

    if (envelope.verification === "failed" && source.failureBehavior !== "SILENT_ON_FAILURE") {
      await markIntegrationActionRunFailed({
        id: job.actionRunId,
        reason: envelope.error || envelope.reason || "integration_action_failed",
        responsePayload: envelope,
        verification: envelope.verification,
      });
      throw new Error(envelope.error || envelope.reason || "integration_action_failed");
    }
    await markIntegrationActionRunSucceeded({
      id: job.actionRunId,
      responsePayload: envelope,
      verification: envelope.verification,
    });
    return;
  }

  if (!job.conversationId) {
    await markIntegrationActionRunSkipped({
      id: job.actionRunId,
      reason: "chat_conversation_missing",
    });
    logger.warn("integration_action.job.chat_conversation_missing", {
      businessProfileId: job.businessProfileId,
      sourceId: job.sourceId,
    });
    return;
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: job.conversationId },
    include: {
      businessProfile: {
        include: {
          externalDataSources: { where: { isActive: true } },
        },
      },
    },
  });

  if (!conversation) {
    await markIntegrationActionRunSkipped({
      id: job.actionRunId,
      reason: "conversation_missing",
    });
    logger.warn("integration_action.job.conversation_missing", {
      conversationId: job.conversationId,
    });
    return;
  }

  let envelope: Awaited<ReturnType<typeof executeExternalQuery>>;
  try {
    envelope = await executeExternalQuery(
      job.businessProfileId,
      job.sourceId,
      job.args ?? {},
      {
        customerPhone: job.customerPhone,
        conversationId: job.conversationId,
        latestUserText: job.latestUserText,
        historyText: job.historyText,
      },
    );
  } catch (error: any) {
    await markIntegrationActionRunFailed({
      id: job.actionRunId,
      reason: error?.message || "integration_action_failed",
    });
    throw error;
  }

  const historyRows = await getConversationHistory(job.conversationId);
  const historyTurns = historyToLlmTurns(toPromptMessages(historyRows));
  const channel = normalizeChannel(conversation.channel);
  const originalRequest =
    job.latestUserText || latestUserMessage(historyTurns) || "the customer's request";

  const reply = await computeBusinessChatReply({
    businessProfile: conversation.businessProfile,
    messageText: `The queued external action for the customer's request has completed. Original customer request: ${originalRequest}`,
    historyTurns,
    channel,
    customerPhone: job.customerPhone || conversation.customerPhone || undefined,
    conversationId: job.conversationId,
    responseMode: conversation.businessProfile.responseMode as "AUTO" | "MANUAL",
    completedExternalLookup: {
      sourceName: source?.name,
      toolName: job.toolName || `integration_action_${job.sourceId}`,
      envelope,
    },
  });

  if (reply.action === "RESOLVE_CONVERSATION") {
    await prisma.conversation.update({
      where: { id: job.conversationId },
      data: { status: "RESOLVED" },
    });
    await markIntegrationActionRunSucceeded({
      id: job.actionRunId,
      responsePayload: envelope,
      verification: envelope.verification,
    });
    return;
  }

  const isAutoMode = conversation.businessProfile.responseMode === "AUTO";
  const content = (reply.privateContent || reply.content || "").trim();
  const status = initialCustomerReplyStatus(
    reply,
    isAutoMode,
    channel === "web" ? "web" : "platform",
  );

  const saved = await saveMessage(job.conversationId, "model", content, {
    status,
    aiReasoning: reply.reasoning,
    handoffCategory: reply.handoffCategory,
    intent: reply.intent,
    isPrivate: channel === "messenger" || channel === "whatsapp",
    origin: "integration_action_result",
  });

  await markIntegrationActionRunSucceeded({
    id: job.actionRunId,
    responsePayload: envelope,
    verification: envelope.verification,
    resultMessageId: saved.id,
  });

  if (status !== "SENDING" || content.length === 0) {
    logger.info("integration_action.job.delivery_deferred", {
      conversationId: job.conversationId,
      action: reply.action,
      status,
      verification: envelope.verification,
    });
    return;
  }

  await deliverExternalLookupReply({
    conversation,
    channel,
    messageId: saved.id,
    content,
  });
}

function normalizeChannel(
  channel: string | null,
): "messenger" | "whatsapp" | "web" | "facebook_comment" {
  if (channel === "whatsapp") return "whatsapp";
  if (channel === "web") return "web";
  if (channel === "facebook_comment") return "facebook_comment";
  return "messenger";
}

function latestUserMessage(
  historyTurns: { role: "user" | "model"; text: string }[],
): string | undefined {
  return [...historyTurns].reverse().find((turn) => turn.role === "user")?.text;
}

async function deliverExternalLookupReply(params: {
  conversation: {
    id: number;
    businessProfileId: number;
    pageId: string;
    senderId: string;
    externalId: string | null;
  };
  channel: "messenger" | "whatsapp" | "web" | "facebook_comment";
  messageId: number;
  content: string;
}) {
  const { conversation, channel, messageId, content } = params;

  if (channel === "web") {
    return;
  }

  try {
    if (channel === "whatsapp") {
      const account = await prisma.whatsAppAccount.findFirst({
        where: { phoneNumberId: conversation.pageId, isActive: true },
        select: { accessToken: true },
      });
      if (!account) throw new Error("WhatsApp account not found");

      const { sendWhatsAppReply } = await import(
        "@modules/meta/whatsapp/whatsapp.service"
      );
      const res = await sendWhatsAppReply(
        conversation.senderId,
        content,
        conversation.pageId,
        decryptFacebookSecret(account.accessToken),
      );
      const wamid = res?.messages?.[0]?.id;
      if (wamid) {
        await prisma.conversationMessage.update({
          where: { id: messageId },
          data: { status: "SENT", externalId: wamid },
        });
      }
      return;
    }

    if (channel === "messenger") {
      const page = await prisma.facebookPage.findFirst({
        where: { pageId: conversation.pageId, isActive: true },
        select: { pageAccessToken: true },
      });
      if (!page) throw new Error("Messenger page not found");

      const { sendMessengerReply } = await import(
        "@modules/meta/messenger/messenger.service"
      );
      const res = await sendMessengerReply(
        conversation.senderId,
        content,
        decryptFacebookSecret(page.pageAccessToken),
      );
      if (res?.message_id) {
        await prisma.conversationMessage.update({
          where: { id: messageId },
          data: { status: "SENT", externalId: res.message_id },
        });
      }
      return;
    }

    logger.info("integration_action.job.comment_delivery_deferred", {
      conversationId: conversation.id,
    });
  } catch (error: any) {
    logger.error("integration_action.job.delivery_failed", {
      conversationId: conversation.id,
      messageId,
      channel,
      error: error?.message || String(error),
    });
    await prisma.conversationMessage.update({
      where: { id: messageId },
      data: { status: "FAILED" },
    });
  }
}

async function buildBackgroundActionArgs(
  job: IntegrationActionJob,
): Promise<Record<string, any>> {
  if (job.args && Object.keys(job.args).length > 0) return job.args;

  if (job.trigger === "CUSTOMER_DETAILS_SAVED" && job.customerId) {
    const customer = await prisma.customer.findFirst({
      where: {
        id: job.customerId,
        businessProfileId: job.businessProfileId,
      },
    });
    if (!customer) return {};
    const capturedFields =
      customer.capturedFields &&
      typeof customer.capturedFields === "object" &&
      !Array.isArray(customer.capturedFields)
        ? (customer.capturedFields as Record<string, unknown>)
        : {};
    return {
      ...capturedFields,
      name: customer.displayName,
      phone: customer.phone,
      email: customer.email,
      notes: customer.notes ?? capturedFields.notes,
      customerId: customer.id,
      conversationId: job.conversationId,
      trigger: job.trigger,
    };
  }

  return {
    trigger: job.trigger,
    conversationId: job.conversationId,
    customerId: job.customerId,
  };
}
