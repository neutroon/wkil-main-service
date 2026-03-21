import prisma from "../../config/prisma";
import generateContent from "../../config/gemini";
import { retrieveRelevantChunks } from "../../rag/rag.service";

interface Message {
  role: "user" | "model";
  content: string;
}

// ─── Send a message back via Messenger Send API ──────────────────────────────

async function sendMessengerReply(
  recipientId: string,
  text: string,
  pageAccessToken: string,
) {
  const response = await fetch(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${pageAccessToken}`,
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

// ─── Build system prompt from business profile ───────────────────────────────

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

// ─── Build conversation history for Gemini ───────────────────────────────────

function buildConversationContents(
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

// ─── Core chat function ───────────────────────────────────────────────────────

export async function handleMessengerMessage(
  pageId: string,
  senderId: string,
  messageText: string,
  history: Message[] = [],
) {
  // 1. Find the FacebookPage + linked BusinessProfile
  const page = await prisma.facebookPage.findFirst({
    where: { pageId, isActive: true },
    include: { businessProfile: true },
  });

  if (!page) {
    throw new Error(`No active page found for pageId: ${pageId}`);
  }

  if (!page.businessProfileId || !page.businessProfile) {
    throw new Error(`Page ${pageId} has no linked business profile`);
  }

  // 2. Retrieve relevant chunks via RAG
  const relevantChunks = await retrieveRelevantChunks(
    page.businessProfileId,
    messageText,
    5,
  );

  // 3. Build prompt
  const systemPrompt = buildSystemPrompt(
    relevantChunks,
    page.businessProfile.name,
  );

  const fullPrompt = buildConversationContents(
    history,
    systemPrompt,
    messageText,
  );

  // 4. Generate reply
  const reply = await generateContent(fullPrompt);

  if (!reply) {
    throw new Error("No reply generated");
  }

  // 5. Send reply via Messenger
  await sendMessengerReply(senderId, reply, page.pageAccessToken);

  console.log(
    `[Messenger] Replied to ${senderId} on page ${pageId}: "${reply.slice(0, 80)}..."`,
  );

  return reply;
}
