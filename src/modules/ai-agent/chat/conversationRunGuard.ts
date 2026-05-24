import { randomUUID } from "crypto";
import prisma from "@config/prisma";
import { cache } from "@utils/cache";
import { logger } from "@utils/logger";

const ACTIVE_RUN_TTL_SECONDS = 15 * 60;

type ActiveConversationRun = {
  runId: string;
  latestUserMessageId: number;
  startedAt: string;
};

export type ConversationAiRun = ActiveConversationRun & {
  conversationId: number;
};

export class StaleConversationRunError extends Error {
  constructor(
    readonly run: ConversationAiRun,
    readonly stage: string,
  ) {
    super("STALE_CONVERSATION_RUN");
    this.name = "StaleConversationRunError";
  }
}

export function isStaleConversationRunError(
  error: unknown,
): error is StaleConversationRunError {
  return error instanceof StaleConversationRunError;
}

function activeRunKey(conversationId: number): string {
  return `conversation:${conversationId}:active_ai_run`;
}

export async function startConversationAiRun(params: {
  conversationId: number;
  latestUserMessageId: number;
}): Promise<ConversationAiRun> {
  const run: ConversationAiRun = {
    conversationId: params.conversationId,
    runId: randomUUID(),
    latestUserMessageId: params.latestUserMessageId,
    startedAt: new Date().toISOString(),
  };

  await cache.set(activeRunKey(params.conversationId), {
    runId: run.runId,
    latestUserMessageId: run.latestUserMessageId,
    startedAt: run.startedAt,
  }, ACTIVE_RUN_TTL_SECONDS);

  logger.info("ai.chat.run_started", {
    conversationId: run.conversationId,
    latestUserMessageId: run.latestUserMessageId,
    runId: run.runId,
  });

  return run;
}

export async function isLatestConversationAiRun(
  run: ConversationAiRun,
): Promise<boolean> {
  const active = await cache.get<ActiveConversationRun>(
    activeRunKey(run.conversationId),
  );

  if (active?.runId) {
    return active.runId === run.runId;
  }

  const newerUserMessage = await prisma.conversationMessage.findFirst({
    where: {
      conversationId: run.conversationId,
      role: "user",
      id: { gt: run.latestUserMessageId },
    },
    select: { id: true },
  });

  return !newerUserMessage;
}

export async function assertLatestConversationAiRun(
  run: ConversationAiRun | undefined,
  stage: string,
): Promise<void> {
  if (!run) return;
  if (await isLatestConversationAiRun(run)) return;

  logger.info("ai.chat.run_superseded", {
    conversationId: run.conversationId,
    latestUserMessageId: run.latestUserMessageId,
    runId: run.runId,
    stage,
  });
  throw new StaleConversationRunError(run, stage);
}

export async function clearConversationAiRun(
  run: ConversationAiRun | undefined,
): Promise<void> {
  if (!run) return;
  const active = await cache.get<ActiveConversationRun>(
    activeRunKey(run.conversationId),
  );
  if (active?.runId === run.runId) {
    await cache.delete(activeRunKey(run.conversationId));
  }
}
