import prisma from "../../config/prisma";
import generateContent from "../../config/gemini";
import { retrieveRelevantChunks } from "../../rag/rag.service";
import {
  getOrCreateConversation,
  getConversationHistory,
  saveMessage,
} from "./conversation.service";

interface Message {
  role: "user" | "model";
  content: string;
}

/** Prisma stores `role` as String; narrow to prompt roles we persist. */
function toPromptMessages(
  rows: { role: string; content: string }[],
): Message[] {
  return rows.map((m) => ({
    role: m.role === "model" ? "model" : "user",
    content: m.content,
  }));
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

function buildSystemPrompt(
  context: { chunkType: string; content: string }[],
  businessName: string,
): string {
  const contextText = context.map((c) => c.content).join("\n\n");

  return `You are a helpful AI assistant for ${businessName}.
You answer customer questions based only on the information provided below.
If you don't know the answer from the provided context, politely say you don't have that information and suggest they contact the business directly.
Keep responses concise and friendly.

BUSINESS CONTEXT:
${contextText}`;
}

function buildFullPrompt(
  history: Message[],
  systemPrompt: string,
  newMessage: string,
): string {
  const historyText = history
    .map((m) => `${m.role === "user" ? "Customer" : "Assistant"}: ${m.content}`)
    .join("\n");

  return `${systemPrompt}

CONVERSATION HISTORY:
${historyText}

Customer: ${newMessage}
Assistant:`;
}

export async function handleMessengerMessage(
  pageId: string,
  senderId: string,
  messageText: string,
) {
  // 1. Find the FacebookPage + linked BusinessProfile
  const page = await prisma.facebookPage.findFirst({
    where: { pageId, isActive: true },
    include: { businessProfile: true },
  });

  if (!page) throw new Error(`No active page found for pageId: ${pageId}`);
  if (!page.businessProfileId || !page.businessProfile) {
    throw new Error(`Page ${pageId} has no linked business profile`);
  }

  // 2. Get or create conversation + load history
  const conversation = await getOrCreateConversation(
    pageId,
    senderId,
    page.businessProfileId,
  );
  const history = await getConversationHistory(conversation.id);

  // 3. Save user message
  await saveMessage(conversation.id, "user", messageText);

  // 4. Retrieve relevant chunks via RAG
  const relevantChunks = await retrieveRelevantChunks(
    page.businessProfileId,
    messageText,
    5,
  );

  // 5. Build prompt with history + context
  const systemPrompt = buildSystemPrompt(
    relevantChunks,
    page.businessProfile.name,
  );
  const fullPrompt = buildFullPrompt(history, systemPrompt, messageText);

  // 6. Generate reply
  const reply = await generateContent(fullPrompt);
  if (!reply) throw new Error("No reply generated");

  // 7. Save assistant reply
  await saveMessage(conversation.id, "model", reply);

  // 8. Send reply via Messenger
  await sendMessengerReply(senderId, reply, page.pageAccessToken);

  console.log(
    `[Messenger] Replied to ${senderId} on page ${pageId}: "${reply.slice(0, 80)}..."`,
  );

  return reply;
}
