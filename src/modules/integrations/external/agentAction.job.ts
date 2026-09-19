import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import { executeExternalQuery } from "./agentActionExecutor.service";
import { executeCustomerTurn } from "@modules/ai-agent/customer/customerAgent.service";
import {
  applyCustomerDecision,
  classifyCustomerDeliveryError,
  type CustomerDeliveryAdapter,
} from "@modules/ai-agent/customer/customerDecision.service";
import {
  markIntegrationActionRunRunning,
  markIntegrationActionRunSkipped,
  markIntegrationActionRunFailed,
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
  const source = await prisma.agentActionSource.findFirst({ where: { id: job.sourceId, businessProfileId: job.businessProfileId, isActive: true, trigger: job.trigger } });
  if (!source) { await markIntegrationActionRunSkipped({ id: job.actionRunId, reason: "source_missing_or_inactive" }); return; }
  if (!job.conversationId) { await markIntegrationActionRunSkipped({ id: job.actionRunId, reason: "chat_conversation_missing" }); return; }
  const conversation = await prisma.conversation.findFirst({ where: { id: job.conversationId, businessProfileId: job.businessProfileId }, include: { businessProfile: { include: { agentActionSources: { where: { isActive: true } } } } } });
  if (!conversation) { await markIntegrationActionRunSkipped({ id: job.actionRunId, reason: "conversation_missing" }); return; }
  const staleBefore = await findNewerCustomerMessageAfterActionStart(job);
  if (staleBefore) { await markIntegrationActionRunSkipped({ id: job.actionRunId, reason: "stale_customer_message" }); return; }
  let envelope: Awaited<ReturnType<typeof executeExternalQuery>>;
  try {
    const [parentRun, workflow] = await Promise.all([
      job.parentRunId ? prisma.integrationActionRun.findUnique({ where: { id: job.parentRunId }, select: { responsePayload: true } }) : Promise.resolve(null),
      job.workflowId ? prisma.agentActionWorkflow.findFirst({ where: { id: job.workflowId, businessProfileId: job.businessProfileId }, select: { inputBindings: true } }) : Promise.resolve(null),
    ]);
    envelope = await executeExternalQuery(job.businessProfileId, job.sourceId, job.args ?? {}, { customerPhone: job.customerPhone, conversationId: job.conversationId, latestUserText: job.latestUserText, historyText: job.historyText, parentActionResponse: parentRun?.responsePayload, workflowInputBindings: workflow?.inputBindings });
  } catch (error: any) {
    await markIntegrationActionRunFailed({ id: job.actionRunId, reason: error?.message || "integration_action_failed" });
    throw error;
  }
  const staleAfter = await findNewerCustomerMessageAfterActionStart(job);
  if (staleAfter) { await markActionRunFromEnvelope({ actionRunId: job.actionRunId, envelope }); return; }
  const channel = normalizeChannel(conversation.channel);
  const actionMessage = completedActionOriginalRequest(job);
  // The customer reply is always a persistent LangGraph customer run, never a
  // one-off capability or a copied history/decision loop in this worker.
  const turn = await executeCustomerTurn({
    userId: conversation.businessProfile.userId,
    businessProfileId: job.businessProfileId,
    conversationId: job.conversationId,
    channel,
    customerText: actionMessage,
    runMode: "inbound",
    dedupeKey: `integration-action:${job.actionRunId ?? job.sourceId}:${job.stepKey ?? "action"}`,
  });
  const decisionResult = await applyCustomerDecision({
    businessProfileId: job.businessProfileId,
    conversationId: job.conversationId,
    agentTurnId: turn.agentTurnId,
    decision: turn.decision,
    origin: "integration_action_result",
    deliver: createExternalLookupDeliveryAdapter({
      conversation: {
        id: conversation.id,
        businessProfileId: job.businessProfileId,
        pageId: conversation.pageId,
        senderId: conversation.senderId,
        externalId: conversation.externalId,
      },
      channel,
    }),
  });
  await markActionRunFromEnvelope({
    actionRunId: job.actionRunId,
    envelope,
    resultMessageId: "message" in decisionResult ? decisionResult.message.id : null,
  });
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

function completedActionOriginalRequest(
  job: IntegrationActionJob,
): string {
  const historyText = (job.historyText || "").trim();
  const latestText = (job.latestUserText || "").trim();

  if (historyText && latestText && !historyText.includes(latestText)) {
    return [
      "Recent chat context before the action:",
      historyText,
      "",
      "Latest customer message:",
      latestText,
    ].join("\n");
  }
  if (historyText) return `Recent chat context before the action:\n${historyText}`;
  if (latestText) return latestText;
  return "the customer's request";
}

async function findNewerCustomerMessageAfterActionStart(
  job: IntegrationActionJob,
): Promise<{ id: number; createdAt: Date } | null> {
  if (!job.conversationId || !job.actionRunId) return null;

  const run = await prisma.integrationActionRun.findUnique({
    where: { id: job.actionRunId },
    select: {
      queuedAt: true,
      createdAt: true,
      agentTurn: {
        select: {
          inputMessageId: true,
        },
      },
    },
  });

  if (!run) return null;

  if (run.agentTurn?.inputMessageId) {
    return prisma.conversationMessage.findFirst({
      where: {
        conversationId: job.conversationId,
        role: "user",
        id: { gt: run.agentTurn.inputMessageId },
      },
      orderBy: { id: "asc" },
      select: { id: true, createdAt: true },
    });
  }

  const referenceDate = run.queuedAt ?? run.createdAt;
  return prisma.conversationMessage.findFirst({
    where: {
      conversationId: job.conversationId,
      role: "user",
      createdAt: { gt: referenceDate },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true },
  });
}

function createExternalLookupDeliveryAdapter(params: {
  conversation: {
    id: number;
    businessProfileId: number;
    pageId: string;
    senderId: string;
    externalId: string | null;
  };
  channel: "messenger" | "whatsapp" | "web" | "facebook_comment";
}): CustomerDeliveryAdapter {
  const { conversation, channel } = params;

  return async (message) => {
    if (channel === "web") return { externalId: null };

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
          message.content,
          conversation.pageId,
          decryptFacebookSecret(account.accessToken),
        ) as { messages?: Array<{ id?: string }> };
        return { externalId: res?.messages?.[0]?.id ?? null };
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
          message.content,
          decryptFacebookSecret(page.pageAccessToken),
        ) as { message_id?: string };
        return { externalId: res?.message_id ?? null };
      }

      throw new Error("Facebook comment action delivery requires comment context");
    } catch (error: any) {
      logger.error("integration_action.job.delivery_failed", {
        conversationId: conversation.id,
        messageId: message.id,
        channel,
        error: error?.message || String(error),
      });
      throw classifyCustomerDeliveryError(error);
    }
  };
}
