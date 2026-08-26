import prisma from "@config/prisma";
import { logger } from "@utils/logger";
import { decryptFacebookSecret } from "@modules/auth/core/tokenCrypto";
import {
  getOrCreateConversation,
  getConversationHistory,
  saveMessage,
} from "../core/conversation.service";
import { AppError } from "@middlewares/errorHandler.middleware";
import { AgentClient } from "@modules/ai-agent/client/agent.client";

// ── Local shims (formerly @modules/ai-agent/chat/*, migrated to agent-svc) ──
function classifyInboundMessageSignal(p: { type?: string; messageText?: string; mediaId?: string; mediaMetadata?: unknown; [k: string]: unknown }) {
  return { shouldTriggerAi: !!p.messageText || !!p.mediaId, reason: "migrated-to-agent-svc" };
}
function toPromptMessages(rows: any[]): any[] {
  return rows.map((r) => ({ role: r.role, content: r.content ?? r.text ?? "" }));
}
function historyToLlmTurns(promptMessages: any[]): any[] { return promptMessages; }
async function computeBusinessChatReply(params: {
  businessProfile: any; messageText?: string; historyTurns: any[];
  channel: string; mediaInfo?: any; conversationId: number;
  [k: string]: unknown;
}) {
  const messages = [
    ...params.historyTurns,
    { role: "user", content: params.messageText ?? "", media: params.mediaInfo },
  ];
  const run = await AgentClient.runAgent({
    business_profile_id: params.businessProfile?.id ?? params.businessProfile?.businessProfileId,
    user_id: params.businessProfile?.userId,
    messages, stage: "fast", channel: params.channel, conversation_id: params.conversationId,
  } as any);
  const text = (run as any)?.output?.content ?? (run as any)?.content ?? "";
  const action = text ? "REPLY" : "HANDOFF_TO_HUMAN";
  return { action, content: text, reasoning: (run as any)?.output?.reasoning ?? "", handoffCategory: text ? null : "NO_AGENT_OUTPUT" };
}
function initialCustomerReplyStatus(reply: { content?: string }) { return reply.content ? "SENDING" : "FAILED"; }
function runSavedModelReplySideEffectsInBackground(_p: any) {
  setImmediate(() => logger.debug("whatsapp.model_side_effects_skipped_migrated"));
}
function scheduleFollowUpsForDeliveredReplyInBackground(_p: any) {
  setImmediate(() => logger.debug("whatsapp.followup_skipped_migrated"));
}



/**
 * Send a text reply via WhatsApp Cloud API (v25.0).
 */
export async function sendWhatsAppReply(
  to: string,
  text: string,
  phoneNumberId: string,
  accessToken: string,
): Promise<any> {
  const response = await fetch(
    `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    },
  );

  if (!response.ok) {
    const error = (await response.json()) as any;
    throw new AppError(`WhatsApp Cloud API error: ${JSON.stringify(error)}`, 502);
  }

  return response.json();
}

/**
 * Send a media message via WhatsApp Cloud API (v25.0).
 */
export async function sendWhatsAppMedia(
  to: string,
  mediaId: string | null,
  type: string, // image, audio, video, document
  phoneNumberId: string,
  accessToken: string,
  caption?: string,
  fileName?: string,
  url?: string,
): Promise<any> {
  const mediaBody: any = mediaId ? { id: mediaId } : { link: url };
  if (caption && (type === "image" || type === "video" || type === "document")) {
    mediaBody.caption = caption;
  }
  if (fileName && type === "document") {
    mediaBody.filename = fileName;
  }

  const response = await fetch(
    `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: type,
        [type]: mediaBody,
      }),
    },
  );

  if (!response.ok) {
    const error = (await response.json()) as any;
    throw new AppError(`WhatsApp Cloud API media error: ${JSON.stringify(error)}`, 502);
  }

  return response.json();
}

export async function sendWhatsAppAction(
  messageId: string,
  phoneNumberId: string,
  accessToken: string,
): Promise<void> {
  const response = await fetch(
    `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      }),
    },
  );
  if (!response.ok) {
    logger.warn("whatsapp.sender_action_failed", {
      messageId,
      error: await response.text(),
    });
  }
}

/**
 * List approved WhatsApp message templates for a given WABA.
 */
export async function listWhatsAppTemplates(
  wabaId: string,
  accessToken: string,
): Promise<any[]> {
  const response = await fetch(
    `https://graph.facebook.com/v25.0/${wabaId}/message_templates?status=APPROVED`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    const error = await response.json();
    logger.error("whatsapp.templates.list_failed", { wabaId, error });
    throw new AppError(`WhatsApp Templates API error: ${JSON.stringify(error)}`, 502);
  }

  const result = (await response.json()) as { data: any[] };
  return result.data || [];
}

/**
 * Send a pre-approved Template message.
 */
export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  languageCode: string,
  components: any[],
  phoneNumberId: string,
  accessToken: string,
): Promise<any> {
  const response = await fetch(
    `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: templateName,
          language: { code: languageCode },
          components,
        },
      }),
    },
  );

  if (!response.ok) {
    const error = await response.json();
    throw new AppError(`WhatsApp Template Send error: ${JSON.stringify(error)}`, 502);
  }

  return response.json();
}

/**
 * Core handler: look up the WhatsApp account → business profile → run RAG + AI → reply.
 * Uses the shared Conversation tables (pageId = phoneNumberId, senderId = customer phone).
 */
export async function handleWhatsAppMessage(
  phoneNumberId: string,
  from: string,
  messageText: string,
  wamid?: string,
  customerName?: string,
  type?: string,
  mediaId?: string,
  mediaMetadata?: any,
): Promise<void> {
  const account = await prisma.whatsAppAccount.findFirst({
    where: { phoneNumberId, isActive: true },
    include: {
      businessProfile: {
        include: {
          agentActionSources: { where: { isActive: true } },
        },
      },
    },
  });

  if (!account) {
    logger.error("whatsapp.account_not_found", { phoneNumberId });
    return;
  }
  if (!account.businessProfileId || !account.businessProfile) {
    logger.error("whatsapp.no_business_profile", { phoneNumberId });
    return;
  }

  let accessToken: string;
  try {
    accessToken = decryptFacebookSecret(account.accessToken);
  } catch (e: unknown) {
    logger.error("whatsapp.decrypt_token_failed", {
      phoneNumberId,
      error: String(e),
    });
    return;
  }

  const businessProfile = account.businessProfile;
  let conversation: any;

  try {
    // 1. Get or Create Conversation
    conversation = await getOrCreateConversation(
      phoneNumberId,
      from,
      account.businessProfileId,
      {
        channel: "whatsapp",
        customerPhone: from,
        customerName: customerName,
      },
    );

    // 2. Save User Message turn
    const historyRows = await getConversationHistory(conversation.id);
    await saveMessage(conversation.id, "user", messageText, {
      externalId: wamid,
      type,
      mediaId,
      mediaMetadata,
    });

    const inboundSignal = classifyInboundMessageSignal({
      type,
      messageText,
      mediaId,
      mediaMetadata,
    });
    if (!inboundSignal.shouldTriggerAi) {
      logger.info("whatsapp.passive_inbound_saved_without_ai", {
        conversationId: conversation.id,
        reason: inboundSignal.reason,
        type,
      });
      return;
    }

    // 4. Compute AI Response
    const historyForPrompt = toPromptMessages(historyRows);
    historyForPrompt.push({ role: "user", content: messageText });
    const historyTurns = historyToLlmTurns(historyForPrompt);

    const reply = await computeBusinessChatReply({
      businessProfile,
      messageText,
      historyTurns,
      channel: "whatsapp",
      customerPhone: from,
      mediaInfo: mediaId ? {
        id: mediaId,
        type: type || "image",
        metadata: mediaMetadata,
      } : undefined,
      conversationId: conversation.id,
    });

    if (reply.action === "RESOLVE_CONVERSATION") {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { status: "RESOLVED" },
      });
      return;
    }

    const status = initialCustomerReplyStatus(reply);

    // 5. Save AI turn
    const modelSaved = await saveMessage(
      conversation.id,
      "model",
      reply.content || "",
      {
        status,
        aiReasoning: reply.reasoning,
        handoffCategory: reply.handoffCategory,
      },
    );

    runSavedModelReplySideEffectsInBackground({
      businessProfileId: account.businessProfileId,
      conversationId: conversation.id,
      message: modelSaved,
      reply,
    });

    // 6. Send API call if AUTO
    if (
      status === "SENDING" &&
      reply.content &&
      reply.handoffCategory !== "SYSTEM_ERROR"
    ) {
      try {
        const platformRes = await sendWhatsAppReply(
          from,
          reply.content,
          phoneNumberId,
          accessToken,
        );
        const modelWamid = (platformRes as any)?.messages?.[0]?.id;

        if (modelWamid) {
          await prisma.conversationMessage.update({
            where: { id: modelSaved.id },
            data: { status: "SENT", externalId: modelWamid },
          });
        }

        scheduleFollowUpsForDeliveredReplyInBackground({
          conversationId: conversation.id,
          businessProfileId: account.businessProfileId,
          message: modelSaved,
          reply,
        });
      } catch (sendErr: any) {
        logger.error("whatsapp.reply_send_failed", { error: sendErr.message });
        await prisma.conversationMessage.update({
          where: { id: modelSaved.id },
          data: { status: "FAILED" },
        });
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("whatsapp.handle_failed", {
      phoneNumberId,
      from,
      error: message,
    });

    // UI Failure Signal
    if (account.businessProfileId && conversation) {
      const errorMsg = `Internal Technical Failure: ${message}`;
      const errorSaved = await saveMessage(conversation.id, "model", errorMsg, {
        status: "FAILED",
        aiReasoning: message,
        handoffCategory: "SYSTEM_ERROR",
      });
      runSavedModelReplySideEffectsInBackground({
        businessProfileId: account.businessProfileId,
        conversationId: conversation.id,
        message: errorSaved,
        reply: {
          action: "HANDOFF_TO_HUMAN",
          handoffCategory: "SYSTEM_ERROR",
          reasoning: message,
        },
      });
    }
  }
}







