import prisma from "@config/prisma";
import { AgentClient } from "@modules/ai-agent/client/agent.client";
import {
  customerAgentDecisionSchema,
  type CustomerAgentDecision,
  type CustomerChannel,
} from "./customerAgent.types";

type RunMode = "inbound" | "follow_up";
type AgentInputMessage = { role: "user" | "assistant" | "system"; content: string };

export type CustomerTurnParams = {
  userId: number;
  businessProfileId: number;
  conversationId: number;
  channel: CustomerChannel;
  inputMessageId?: number | null;
  customerText: string;
  runMode: RunMode;
  dedupeKey: string;
  mediaContext?: string | null;
  followUpIndex?: number | null;
  signal?: AbortSignal;
};

export type CustomerTurnHandle = {
  agentTurnId: number;
  threadId: string;
  runId: string;
};

export type CustomerTurnResult = CustomerTurnHandle & {
  decision: CustomerAgentDecision;
};

type ConversationThread = {
  id: number;
  businessProfileId: number;
  agentThreadId: string | null;
  agentHistorySeededAt: Date | null;
};

type PersistedTurn = {
  id: number;
  agentRunId: string | null;
  status: string;
  decision?: unknown;
};

// Prisma protects the durable cross-process record; this small coalescer also
// closes the otherwise unavoidable SDK-create race for simultaneous jobs in
// the same Node worker. Cross-process retries recover by the run metadata.
const inFlightPrepares = new Map<string, Promise<CustomerTurnHandle>>();

export function prepareCustomerTurn(params: CustomerTurnParams): Promise<CustomerTurnHandle> {
  const inFlight = inFlightPrepares.get(params.dedupeKey);
  if (inFlight) return inFlight;

  const preparation = prepareCustomerTurnOnce(params).finally(() => {
    if (inFlightPrepares.get(params.dedupeKey) === preparation) {
      inFlightPrepares.delete(params.dedupeKey);
    }
  });
  inFlightPrepares.set(params.dedupeKey, preparation);
  return preparation;
}

async function prepareCustomerTurnOnce(params: CustomerTurnParams): Promise<CustomerTurnHandle> {
  const conversation = await ensureConversationThread(params);
  const threadId = conversation.agentThreadId;
  if (!threadId) throw new Error("Customer conversation is missing an agent thread ID");

  await AgentClient.ensureCustomerThread(threadId, {
    businessProfileId: params.businessProfileId,
    conversationId: params.conversationId,
    channel: params.channel,
  }, params.signal);

  const shouldSeed = await shouldSeedHistory(conversation, threadId, params.signal);
  const turn = await upsertTurn(params);
  const runId = turn.agentRunId ?? await recoverOrStartRun({ params, threadId, turn, shouldSeed });

  // Do not replace this timestamp on TTL recovery: it is an audit of the
  // initial seed, while the thread state itself determines whether reseeding is
  // needed after an Agent Server TTL expiry.
  await prisma.conversation.updateMany({
    where: {
      id: params.conversationId,
      businessProfileId: params.businessProfileId,
      agentHistorySeededAt: null,
    },
    data: { agentHistorySeededAt: new Date() },
  });

  return { agentTurnId: turn.id, threadId, runId };
}

async function ensureConversationThread(params: CustomerTurnParams): Promise<ConversationThread> {
  const proposedThreadId = crypto.randomUUID();
  await prisma.conversation.updateMany({
    where: {
      id: params.conversationId,
      businessProfileId: params.businessProfileId,
      agentThreadId: null,
    },
    data: { agentThreadId: proposedThreadId },
  });

  return prisma.conversation.findFirstOrThrow({
    where: { id: params.conversationId, businessProfileId: params.businessProfileId },
    select: { id: true, businessProfileId: true, agentThreadId: true, agentHistorySeededAt: true },
  });
}

async function shouldSeedHistory(
  conversation: ConversationThread,
  threadId: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!conversation.agentHistorySeededAt) return true;
  const state = await AgentClient.getCustomerThreadState(threadId, signal);
  return !hasPersistedMessages(state);
}

function hasPersistedMessages(state: Record<string, unknown>): boolean {
  if (Array.isArray(state.messages)) return state.messages.length > 0;
  // Keep this tolerant of the SDK's raw state envelope for recovery tests and
  // older Agent Server patch releases.
  const values = state.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) return false;
  const messages = (values as Record<string, unknown>).messages;
  return Array.isArray(messages) && messages.length > 0;
}

async function upsertTurn(params: CustomerTurnParams): Promise<PersistedTurn> {
  return prisma.agentTurn.upsert({
    where: { dedupeKey: params.dedupeKey },
    create: {
      businessProfileId: params.businessProfileId,
      conversationId: params.conversationId,
      inputMessageId: params.inputMessageId ?? null,
      channel: params.channel,
      mode: params.runMode === "follow_up" ? "FOLLOW_UP" : "CUSTOMER_MESSAGE",
      status: "RUNNING",
      dedupeKey: params.dedupeKey,
      customerText: params.customerText,
    },
    update: {},
  });
}

async function recoverOrStartRun(input: {
  params: CustomerTurnParams;
  threadId: string;
  turn: PersistedTurn;
  shouldSeed: boolean;
}): Promise<string> {
  const recovered = await AgentClient.findCustomerRunByDedupeKey(
    input.threadId,
    input.params.dedupeKey,
    input.params.signal,
  );
  const runId = recovered?.runId ?? (await AgentClient.startCustomerRun({
    threadId: input.threadId,
    messages: await messagesForRun(input.params, input.shouldSeed),
    context: {
      userId: input.params.userId,
      businessProfileId: input.params.businessProfileId,
      conversationId: input.params.conversationId,
      channel: input.params.channel,
      runMode: input.params.runMode,
      mediaContext: input.params.mediaContext,
      followUpIndex: input.params.followUpIndex,
    },
    dedupeKey: input.params.dedupeKey,
    signal: input.params.signal,
  })).runId;

  const stored = await prisma.agentTurn.updateMany({
    where: { id: input.turn.id, agentRunId: null },
    data: { agentRunId: runId },
  });
  if (stored.count > 0) return runId;

  const current = await prisma.agentTurn.findUniqueOrThrow({
    where: { id: input.turn.id },
    select: { id: true, agentRunId: true },
  });
  if (!current.agentRunId) throw new Error("Customer agent run was not persisted");
  return current.agentRunId;
}

async function messagesForRun(params: CustomerTurnParams, includeHistory: boolean): Promise<AgentInputMessage[]> {
  const messages: AgentInputMessage[] = [];
  if (includeHistory) {
    const history = await prisma.conversationMessage.findMany({
      where: {
        conversationId: params.conversationId,
        ...(params.inputMessageId == null ? {} : { NOT: { id: params.inputMessageId } }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 24,
      select: { id: true, role: true, content: true },
    });
    for (const message of history.reverse()) {
      if (message.role === "user") messages.push({ role: "user", content: message.content });
      if (message.role === "model" || message.role === "agent") {
        messages.push({ role: "assistant", content: message.content });
      }
    }
  }
  if (params.customerText.length > 0) messages.push({ role: "user", content: params.customerText });
  return messages;
}

export async function executeCustomerTurn(params: CustomerTurnParams): Promise<CustomerTurnResult> {
  const handle = await prepareCustomerTurn(params);
  try {
    const decision = customerAgentDecisionSchema.parse(await AgentClient.joinCustomerRun(
      handle.threadId,
      handle.runId,
      { signal: params.signal },
    ));
    await prisma.agentTurn.update({
      where: { id: handle.agentTurnId },
      data: { decision, status: "COMPLETED", failureReason: null },
    });
    return { ...handle, decision };
  } catch (error) {
    await prisma.agentTurn.update({
      where: { id: handle.agentTurnId },
      data: { status: "FAILED", failureReason: redactedFailureCode(error) },
    });
    throw error;
  }
}

function redactedFailureCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "CUSTOMER_AGENT_RUN_ABORTED") return "CUSTOMER_AGENT_RUN_ABORTED";
  if (error instanceof Error && /timeout/i.test(error.message)) return "CUSTOMER_AGENT_TIMEOUT";
  return "CUSTOMER_AGENT_FAILURE";
}
