import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { executeExternalQuery } from "./agentActionExecutor.service";
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
  notifySavedModelReplySideEffects,
  scheduleFollowUpsForDeliveredReply,
} from "@modules/ai-agent/chat/replySideEffects.service";
import { createAgentTurn } from "@modules/ai-agent/core/agentTurn.service";
import { validateChatRequestedExternalAction } from "@modules/ai-agent/chat/externalToolEligibility";
import {
  listActiveAgentActionWorkflows,
  nextMutationSourceForCompletedLookup,
} from "./agentActionWorkflow.service";
import {
  markIntegrationActionRunFailed,
  markIntegrationActionRunRunning,
  markIntegrationActionRunSkipped,
  markIntegrationActionRunSucceeded,
} from "./integrationActionRun.service";

export type IntegrationActionTrigger = "CHAT_REQUESTED";

export type IntegrationActionJob = {
  businessProfileId: number;
  trigger: IntegrationActionTrigger;
  sourceId: number;
  actionRunId?: number | null;
  agentTurnId?: number | null;
  parentRunId?: number | null;
  workflowId?: number | null;
  stepKey?: string | null;
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

  const source = await prisma.agentActionSource.findFirst({
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
          agentActionSources: { where: { isActive: true } },
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

  const actionValidation = await validateChatRequestedExternalAction({
    source,
    latestUserMessage: job.latestUserText || "",
    args: job.args,
    historyText: job.historyText,
    customerPhone: job.customerPhone,
    conversationId: job.conversationId ?? undefined,
  });
  if (!actionValidation.shouldQueue) {
    await markIntegrationActionRunSkipped({
      id: job.actionRunId,
      reason: "action_policy_rejected",
    });
    logger.warn("integration_action.job.chat_action_policy_skipped", {
      businessProfileId: job.businessProfileId,
      sourceId: job.sourceId,
      conversationId: job.conversationId,
      reason: actionValidation.reasoning,
      latestUserText: job.latestUserText?.slice(0, 120),
    });
    return;
  }

  let envelope: Awaited<ReturnType<typeof executeExternalQuery>>;
  try {
    const [parentRun, workflowForExecution] = await Promise.all([
      job.parentRunId
        ? prisma.integrationActionRun.findUnique({
            where: { id: job.parentRunId },
            select: { responsePayload: true },
          })
        : Promise.resolve(null),
      job.workflowId
        ? prisma.agentActionWorkflow.findFirst({
            where: {
              id: job.workflowId,
              businessProfileId: job.businessProfileId,
            },
            select: { inputBindings: true },
          })
        : Promise.resolve(null),
    ]);
    envelope = await executeExternalQuery(
      job.businessProfileId,
      job.sourceId,
      job.args ?? {},
      {
        customerPhone: job.customerPhone,
        conversationId: job.conversationId,
        latestUserText: job.latestUserText,
        historyText: job.historyText,
        parentActionResponse: parentRun?.responsePayload,
        workflowInputBindings: workflowForExecution?.inputBindings,
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
  const workflows = await listActiveAgentActionWorkflows(job.businessProfileId);
  const workflow =
    (job.workflowId
      ? workflows.find((item) => item.id === job.workflowId)
      : workflows.find((item) => item.lookupSourceId === source.id)) || null;
  const nextMutationSource =
    envelope.success && envelope.verification === "verified"
      ? nextMutationSourceForCompletedLookup(workflow, source)
      : null;
  const actionResultTurn = await createAgentTurn({
    businessProfileId: job.businessProfileId,
    conversationId: job.conversationId,
    channel,
    mode: "ACTION_RESULT",
    customerText: originalRequest,
    parentActionRunId: job.actionRunId ?? null,
    activeWorkflowId: workflow?.id ?? null,
  });

  const reply = await computeBusinessChatReply({
    businessProfile: conversation.businessProfile,
    messageText: originalRequest,
    historyTurns,
    channel,
    customerPhone: job.customerPhone || conversation.customerPhone || undefined,
    conversationId: job.conversationId,
    agentTurnId: actionResultTurn.id,
    parentActionRunId: job.actionRunId ?? null,
    activeWorkflowId: workflow?.id ?? null,
    actionStepKey: nextMutationSource ? "mutation" : null,
    allowedActionSourceIds: nextMutationSource ? [nextMutationSource.id] : [],
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
    await markActionRunFromEnvelope({
      actionRunId: job.actionRunId,
      envelope,
    });
    return;
  }

  const content = (reply.privateContent || reply.content || "").trim();

  if (reply.action === "REPLY_AUTO" && content.length === 0 && !reply.attachment) {
    await markActionRunFromEnvelope({
      actionRunId: job.actionRunId,
      envelope,
    });
    logger.info("integration_action.job.empty_reply_skipped", {
      conversationId: job.conversationId,
      sourceId: job.sourceId,
      actionRunId: job.actionRunId,
      queuedActionRunId: reply.queuedActionRunId,
      agentTurnStatus: reply.agentTurnStatus,
      verification: envelope.verification,
    });
    return;
  }

  const status = initialCustomerReplyStatus(
    reply,
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

  await markActionRunFromEnvelope({
    actionRunId: job.actionRunId,
    envelope,
    resultMessageId: saved.id,
  });

  await notifySavedModelReplySideEffects({
    businessProfileId: job.businessProfileId,
    conversationId: job.conversationId,
    message: saved,
    reply,
  });

  if (status !== "SENDING" || content.length === 0) {
    logger.info("integration_action.job.delivery_deferred", {
      conversationId: job.conversationId,
      action: reply.action,
      status,
      verification: envelope.verification,
    });
    if (status === "SENT" && content.length > 0) {
      await scheduleFollowUpsForDeliveredReply({
        businessProfileId: job.businessProfileId,
        conversationId: job.conversationId,
        message: saved,
        reply,
      });
    }
    return;
  }

  const delivered = await deliverExternalLookupReply({
    conversation,
    channel,
    messageId: saved.id,
    content,
  });
  if (delivered) {
    await scheduleFollowUpsForDeliveredReply({
      businessProfileId: job.businessProfileId,
      conversationId: job.conversationId,
      message: saved,
      reply,
    });
  }
}

async function markActionRunFromEnvelope(params: {
  actionRunId?: number | null;
  envelope: Awaited<ReturnType<typeof executeExternalQuery>>;
  resultMessageId?: number | null;
}) {
  if (params.envelope.success) {
    await markIntegrationActionRunSucceeded({
      id: params.actionRunId,
      responsePayload: params.envelope,
      verification: params.envelope.verification,
      resultMessageId: params.resultMessageId,
    });
    return;
  }

  await markIntegrationActionRunFailed({
    id: params.actionRunId,
    reason: params.envelope.reason || "action_failed",
    responsePayload: params.envelope,
    verification: params.envelope.verification,
    resultMessageId: params.resultMessageId,
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
}): Promise<boolean> {
  const { conversation, channel, messageId, content } = params;

  if (channel === "web") {
    return true;
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
        return true;
      }
      return false;
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
        return true;
      }
      return false;
    }

    logger.info("integration_action.job.comment_delivery_deferred", {
      conversationId: conversation.id,
    });
    return false;
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
    return false;
  }
}
