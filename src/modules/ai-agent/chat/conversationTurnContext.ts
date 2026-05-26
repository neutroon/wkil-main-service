import prisma from "@config/prisma";
import {
  promptMessagesToLlmTurns,
  toPromptMessages,
} from "./conversationTurns";

const HISTORY_LIMIT = 24;

type ConversationTurnRow = {
  role: string;
  content: string;
  type?: string | null;
  mediaId?: string | null;
  mediaMetadata?: unknown;
};

function joinUserTurn(rows: ConversationTurnRow[]): string {
  return toPromptMessages(rows)
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n");
}

export async function buildUnansweredUserTurnContext(params: {
  conversationId: number;
  latestUserMessageId: number;
  postId?: string;
}): Promise<{
  messageText: string;
  historyTurns: { role: "user" | "model"; text: string }[];
  userMessageIds: number[];
}> {
  const latestUserMessage = await prisma.conversationMessage.findFirst({
    where: {
      id: params.latestUserMessageId,
      conversationId: params.conversationId,
      role: "user",
      ...(params.postId ? { conversation: { postId: params.postId } } : {}),
    },
    select: { id: true },
  });

  if (!latestUserMessage) {
    throw new Error("LATEST_USER_MESSAGE_NOT_FOUND");
  }

  const postFilter = params.postId
    ? { conversation: { postId: params.postId } }
    : {};

  const lastResponder = await prisma.conversationMessage.findFirst({
    where: {
      conversationId: params.conversationId,
      role: { in: ["model", "agent"] },
      id: { lt: latestUserMessage.id },
      ...postFilter,
    },
    orderBy: { id: "desc" },
    select: { id: true },
  });
  const boundaryId = lastResponder?.id ?? 0;

  const [historyRowsDesc, unansweredUserRows] = await Promise.all([
    boundaryId > 0
      ? prisma.conversationMessage.findMany({
          where: {
            conversationId: params.conversationId,
            id: { lte: boundaryId },
            ...postFilter,
          },
          orderBy: { id: "desc" },
          take: HISTORY_LIMIT,
        })
      : Promise.resolve([]),
    prisma.conversationMessage.findMany({
      where: {
        conversationId: params.conversationId,
        role: "user",
        id: { gt: boundaryId, lte: latestUserMessage.id },
        ...postFilter,
      },
      orderBy: { id: "asc" },
    }),
  ]);

  return {
    messageText: joinUserTurn(unansweredUserRows),
    historyTurns: promptMessagesToLlmTurns(
      toPromptMessages(historyRowsDesc.reverse()),
    ),
    userMessageIds: unansweredUserRows.map((message) => message.id),
  };
}
