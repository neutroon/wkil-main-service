import { AgentClient } from "@modules/ai-agent/client/agent.client";
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
import { formatCompletedActionRequestMessage } from "@modules/ai-agent/chat/completedActionRequest";
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
  return AgentClient.runAgent({
    business_profile_id: job.businessProfileId,
    user_id: undefined,
    messages: [],
    stage: "fast",
  } as any) as any;
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

function completedActionOriginalRequest(
  job: IntegrationActionJob,
  historyTurns: { role: "user" | "model"; text: string }[],
): string {
  const historyText = actionRequestHistoryText(historyTurns) ||
    (job.historyText || "").trim();
  const latestText =
    (job.latestUserText || latestUserMessage(historyTurns) || "").trim();

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

function actionRequestHistoryText(
  historyTurns: { role: "user" | "model"; text: string }[],
): string {
  return historyTurns
    .map((turn) => {
      const text = turn.text.trim();
      if (!text) return "";
      return `${turn.role === "user" ? "Customer" : "Assistant"}: ${text}`;
    })
    .filter(Boolean)
    .join("\n");
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
