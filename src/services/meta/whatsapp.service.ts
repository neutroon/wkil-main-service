import prisma from "../../config/prisma";
import { generateMessengerAssistantReply } from "../../config/gemini";
import { retrieveRelevantChunks } from "../../rag/rag.service";
import { logger } from "../../utils/logger";
import { decryptFacebookSecret } from "../../utils/tokenCrypto";
import {
  getOrCreateConversation,
  getConversationHistory,
  saveMessage,
} from "./conversation.service";

interface Message {
  role: "user" | "model";
  content: string;
}

const FALLBACK_REPLY =
  "Sorry, we can't respond right now. Please try again or contact the business directly.";

const NOT_INGESTED_REPLY =
  "We're still setting up our assistant. Please contact us directly for now — we'll be with you shortly.";

const MAX_HISTORY_CHARS = 12_000;

function toPromptMessages(
  rows: { role: string; content: string }[],
): Message[] {
  return rows.map((m) => ({
    role: m.role === "model" ? "model" : "user",
    content: m.content,
  }));
}

function historyToLlmTurns(
  historyIncludingLatestUser: Message[],
): { role: "user" | "model"; text: string }[] {
  const prior = historyIncludingLatestUser.slice(0, -1);
  const turns: { role: "user" | "model"; text: string }[] = [];
  let used = 0;
  for (let i = prior.length - 1; i >= 0; i--) {
    const m = prior[i]!;
    if (used + m.content.length > MAX_HISTORY_CHARS) break;
    turns.unshift({ role: m.role, text: m.content });
    used += m.content.length;
  }
  return turns;
}

/**
 * Send a text reply via WhatsApp Cloud API (v25.0).
 */
export async function sendWhatsAppReply(
  to: string,
  text: string,
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
        to,
        type: "text",
        text: { body: text },
      }),
    },
  );

  if (!response.ok) {
    const error = (await response.json()) as unknown;
    throw new Error(
      `WhatsApp Cloud API error: ${JSON.stringify(error)}`,
    );
  }
}

function buildSystemPromptWithContext(
  context: { chunkType: string; content: string }[],
  businessProfile: { name: string; voice: string; tone: string },
): string {
  const contextText = context.map((c) => c.content).join("\n\n");
  const toneInstruction = `\nFollow this voice strictly: ${businessProfile.voice}\nFollow this tone strictly: ${businessProfile.tone}`;

  return `You are a helpful AI assistant for ${businessProfile.name}.
You answer customer questions based only on the information provided below.
If you don't know the answer from the provided context, politely say you don't have that information and suggest they contact the business directly.
${toneInstruction}

BUSINESS CONTEXT:
${contextText}`;
}

function buildSystemPromptNoRetrievedContext(
  businessProfile: { name: string; voice: string; tone: string },
): string {
  const toneInstruction = `\nFollow this voice strictly: ${businessProfile.voice}\nFollow this tone strictly: ${businessProfile.tone}`;

  return `You are a helpful AI assistant for ${businessProfile.name}.
No relevant knowledge base passages were retrieved for this question.
Do not invent business facts, prices, policies, or hours.
Politely say you don't have that specific information and suggest the customer contact the business directly.
${toneInstruction}`;
}

/**
 * Core handler: look up the WhatsApp account → business profile → run RAG + AI → reply.
 * Uses the shared Conversation tables (pageId = phoneNumberId, senderId = customer phone).
 */
export async function handleWhatsAppMessage(
  phoneNumberId: string,
  from: string,
  messageText: string,
): Promise<void> {
  const account = await prisma.whatsAppAccount.findFirst({
    where: { phoneNumberId, isActive: true },
    include: { businessProfile: true },
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
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("whatsapp.decrypt_token_failed", { phoneNumberId, error: msg });
    return;
  }

  const businessProfile = account.businessProfile;

  try {
    // Reuse existing Conversation infrastructure — pageId maps to phoneNumberId
    const conversation = await getOrCreateConversation(
      phoneNumberId,
      from,
      account.businessProfileId,
      { channel: "whatsapp", customerPhone: from },
    );
    const historyRows = await getConversationHistory(conversation.id);
    await saveMessage(conversation.id, "user", messageText);

    const historyForPrompt = toPromptMessages(historyRows);
    historyForPrompt.push({ role: "user", content: messageText });
    const historyTurns = historyToLlmTurns(historyForPrompt);

    let reply: string;

    if (!businessProfile.ragIngested) {
      reply = NOT_INGESTED_REPLY;
    } else {
      const relevantChunks = await retrieveRelevantChunks(
        account.businessProfileId,
        messageText,
        5,
      );

      const systemInstruction =
        relevantChunks.length > 0
          ? buildSystemPromptWithContext(relevantChunks, businessProfile)
          : buildSystemPromptNoRetrievedContext(businessProfile);

      const generated = await generateMessengerAssistantReply({
        systemInstruction,
        historyTurns,
        customerMessage: messageText,
      });

      if (!generated?.trim()) throw new Error("No reply generated");
      reply = generated.trim();
    }

    await saveMessage(conversation.id, "model", reply);
    await sendWhatsAppReply(from, reply, phoneNumberId, accessToken);

    logger.info("whatsapp.reply_sent", {
      phoneNumberId,
      from,
      preview: reply.slice(0, 80),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("whatsapp.handle_failed", { phoneNumberId, from, error: message });
    try {
      await sendWhatsAppReply(from, FALLBACK_REPLY, phoneNumberId, accessToken!);
    } catch (sendErr: unknown) {
      const sm = sendErr instanceof Error ? sendErr.message : String(sendErr);
      logger.error("whatsapp.fallback_send_failed", { phoneNumberId, from, error: sm });
    }
  }
}
