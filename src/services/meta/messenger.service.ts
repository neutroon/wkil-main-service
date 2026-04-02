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

interface Message {
  role: "user" | "model";
  content: string;
}

const FALLBACK_REPLY =
  "Sorry, we can't respond right now. Please try again or contact the business directly.";

const NOT_INGESTED_REPLY =
  "We're still setting up our assistant for this page. Please contact us directly for now—we'll be with you shortly.";

/** Prior turns for the LLM (token budget). */
const MAX_HISTORY_CHARS = 12_000;

/** Prisma stores `role` as String; narrow to prompt roles we persist. */
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
  /** Exclude the last user message — it is passed as `customerMessage`. */
  const prior = historyIncludingLatestUser.slice(0, -1);
  const turns: { role: "user" | "model"; text: string }[] = [];
  let used = 0;
  for (let i = prior.length - 1; i >= 0; i--) {
    const m = prior[i]!;
    const piece = m.content;
    if (used + piece.length > MAX_HISTORY_CHARS) break;
    turns.unshift({ role: m.role, text: piece });
    used += piece.length;
  }
  return turns;
}

async function sendMessengerReply(
  recipientId: string,
  text: string,
  pageAccessToken: string,
) {
  const response = await fetch(
    `https://graph.facebook.com/v25.0/me/messages?access_token=${pageAccessToken}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
      }),
    },
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Messenger Send API error: ${JSON.stringify(error)}`);
  }

  return response.json();
}



export async function handleMessengerMessage(
  pageId: string,
  senderId: string,
  messageText: string,
) {
  const page = await prisma.facebookPage.findFirst({
    where: { pageId, isActive: true },
    include: { businessProfile: true },
  });

  if (!page) {
    logger.error("messenger.page_not_found", { pageId });
    return;
  }
  if (!page.businessProfileId || !page.businessProfile) {
    logger.error("messenger.no_business_profile", { pageId });
    return;
  }

  let pageAccessToken: string;
  try {
    pageAccessToken = decryptFacebookSecret(page.pageAccessToken);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error("messenger.decrypt_token_failed", { pageId, error: msg });
    return;
  }

  const businessProfile = page.businessProfile;

  try {
    const conversation = await getOrCreateConversation(
      pageId,
      senderId,
      page.businessProfileId,
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
        page.businessProfileId,
        messageText,
        5,
      );

      const systemInstruction = buildSystemPrompt(
        businessProfile as any,
        relevantChunks,
      );

      const generated = await generateMessengerAssistantReply({
        systemInstruction,
        historyTurns,
        customerMessage: messageText,
      });

      if (!generated?.trim()) {
        throw new Error("No reply generated");
      }
      reply = generated.trim();
    }

    await saveMessage(conversation.id, "model", reply);
    await sendMessengerReply(senderId, reply, pageAccessToken);

    logger.info("messenger.reply_sent", {
      pageId,
      senderId,
      preview: reply.slice(0, 80),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("messenger.handle_failed", {
      pageId,
      senderId,
      error: message,
    });
    try {
      await sendMessengerReply(senderId, FALLBACK_REPLY, pageAccessToken);
    } catch (sendErr: unknown) {
      const sm = sendErr instanceof Error ? sendErr.message : String(sendErr);
      logger.error("messenger.fallback_send_failed", {
        pageId,
        senderId,
        error: sm,
      });
    }
  }
}
