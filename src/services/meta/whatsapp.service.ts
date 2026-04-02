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
import { buildSystemPrompt } from "./prompt.service";
import { buildCaptureLeadTool, buildExternalQueryTools } from "../../config/gemini";
import { runAIEngineLoop } from "../ai/aiEngine.service";

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
    include: { 
      businessProfile: {
        include: {
          externalDataSources: { where: { isActive: true } },
          crmIntegrations: { where: { isActive: true }, take: 1 }
        }
      } 
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

      const systemInstruction = buildSystemPrompt(
        businessProfile as any,
        relevantChunks,
      );

      const tools = [];
      const captureTool = businessProfile.crmIntegrations.length > 0 
        ? buildCaptureLeadTool(businessProfile.crmIntegrations[0].fieldMapping) 
        : [];
      const externalTools = buildExternalQueryTools(businessProfile.externalDataSources);

      if (captureTool.length > 0) tools.push(...captureTool);
      
      // Combine functionDeclarations into a single Tool object to satisfy Gemini SDK if needed,
      // or we can pass multiple Tool objects. Usually, one Tool object with an array of functionDeclarations is best.
      let finalTools = undefined;
      if (tools.length > 0 || externalTools.length > 0) {
        finalTools = [{
          functionDeclarations: [
            ...(tools[0]?.functionDeclarations || []),
            ...(externalTools.length > 0 && externalTools[0].functionDeclarations ? externalTools[0].functionDeclarations : [])
          ]
        }];
      }

      reply = await runAIEngineLoop({
        systemInstruction,
        historyTurns,
        customerMessage: messageText,
        tools: finalTools,
        businessProfileId: businessProfile.id,
        customerPhone: from,
      });

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
