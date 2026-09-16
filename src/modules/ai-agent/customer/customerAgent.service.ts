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
  agentSeedLeaseOwner: string | null;
  agentSeedLeaseExpiresAt: Date | null;
};

type PersistedTurn = {
  id: number;
  businessProfileId: number;
  conversationId: number;
  channel: string;
  agentRunId: string | null;
  status: string;
  decision?: unknown;
};

const LEASE_DURATION_MS = 120_000;

export class CustomerAgentLeaseBusyError extends Error {
  readonly code = "CUSTOMER_AGENT_LEASE_BUSY";

  constructor(resource: "run" | "history") {
    super(`Customer agent ${resource} lease is held by another worker`);
    this.name = "CustomerAgentLeaseBusyError";
  }
}

// This only avoids redundant work inside one Node process. The database lease
// below remains the correctness mechanism across BullMQ workers and hosts.
const inFlightPrepares = new Map<string, Promise<CustomerTurnHandle>>();

export function prepareCustomerTurn(params: CustomerTurnParams): Promise<CustomerTurnHandle> {
  const durableDedupeKey = customerTurnDedupeKey(params);
  const inFlight = inFlightPrepares.get(durableDedupeKey);
  if (inFlight) return inFlight;

  const preparation = prepareCustomerTurnOnce(params, durableDedupeKey).finally(() => {
    if (inFlightPrepares.get(durableDedupeKey) === preparation) {
      inFlightPrepares.delete(durableDedupeKey);
    }
  });
  inFlightPrepares.set(durableDedupeKey, preparation);
  return preparation;
}

async function prepareCustomerTurnOnce(
  params: CustomerTurnParams,
  durableDedupeKey: string,
): Promise<CustomerTurnHandle> {
  const conversation = await ensureConversationThread(params);
  const threadId = conversation.agentThreadId;
  if (!threadId) throw new Error("Customer conversation is missing an agent thread ID");

  await AgentClient.ensureCustomerThread(threadId, {
    businessProfileId: params.businessProfileId,
    conversationId: params.conversationId,
    channel: params.channel,
  }, params.signal);

  const turn = await upsertTurn(params, durableDedupeKey);
  if (turn.agentRunId) return { agentTurnId: turn.id, threadId, runId: turn.agentRunId };

  const leaseOwner = crypto.randomUUID();
  const ownsRunLease = await claimRunLease(turn.id, leaseOwner);
  if (!ownsRunLease) {
    const current = await prisma.agentTurn.findUniqueOrThrow({
      where: { id: turn.id },
      select: { id: true, businessProfileId: true, conversationId: true, channel: true, agentRunId: true, status: true, decision: true },
    });
    assertTurnScope(current, params);
    if (current.agentRunId) return { agentTurnId: current.id, threadId, runId: current.agentRunId };
    throw new CustomerAgentLeaseBusyError("run");
  }

  let seed: { shouldSeed: boolean; leaseOwner: string | null };
  try {
    seed = await claimHistorySeedLease(conversation, threadId, params);
  } catch (error) {
    // No remote run has been started yet, so this owner can safely release its
    // turn lease and let the queued job retry after the seed owner finishes.
    await releaseRunLease(turn.id, leaseOwner);
    throw error;
  }
  try {
    const runId = await recoverOrStartRun({
      params,
      threadId,
      turn,
      shouldSeed: seed.shouldSeed,
      leaseOwner,
      durableDedupeKey,
    });
    if (seed.leaseOwner) await completeHistorySeedLease(params, seed.leaseOwner);
    return { agentTurnId: turn.id, threadId, runId };
  } catch (error) {
    if (seed.leaseOwner) await releaseHistorySeedLease(params, seed.leaseOwner);
    throw error;
  }
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
    select: {
      id: true, businessProfileId: true, agentThreadId: true, agentHistorySeededAt: true,
      agentSeedLeaseOwner: true, agentSeedLeaseExpiresAt: true,
    },
  });
}

async function claimHistorySeedLease(
  conversation: ConversationThread,
  threadId: string,
  params: CustomerTurnParams,
): Promise<{ shouldSeed: boolean; leaseOwner: string | null }> {
  const owner = crypto.randomUUID();
  const now = new Date();
  const claimed = await prisma.conversation.updateMany({
    where: {
      id: conversation.id,
      businessProfileId: params.businessProfileId,
      OR: [
        { agentSeedLeaseExpiresAt: null },
        { agentSeedLeaseExpiresAt: { lt: now } },
      ],
    },
    data: { agentSeedLeaseOwner: owner, agentSeedLeaseExpiresAt: leaseExpiry(now) },
  });
  if (claimed.count === 0) throw new CustomerAgentLeaseBusyError("history");

  const state = await AgentClient.getCustomerThreadState(threadId, params.signal);
  if (hasPersistedMessages(state)) {
    await completeHistorySeedLease(params, owner);
    return { shouldSeed: false, leaseOwner: null };
  }
  return { shouldSeed: true, leaseOwner: owner };
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

async function upsertTurn(params: CustomerTurnParams, durableDedupeKey: string): Promise<PersistedTurn> {
  const turn = await prisma.agentTurn.upsert({
    where: { dedupeKey: durableDedupeKey },
    create: {
      businessProfileId: params.businessProfileId,
      conversationId: params.conversationId,
      inputMessageId: params.inputMessageId ?? null,
      channel: params.channel,
      mode: params.runMode === "follow_up" ? "FOLLOW_UP" : "CUSTOMER_MESSAGE",
      status: "RUNNING",
      dedupeKey: durableDedupeKey,
      customerText: params.customerText,
    },
    update: {},
  });
  assertTurnScope(turn, params);
  return turn;
}

async function recoverOrStartRun(input: {
  params: CustomerTurnParams;
  threadId: string;
  turn: PersistedTurn;
  shouldSeed: boolean;
  leaseOwner: string;
  durableDedupeKey: string;
}): Promise<string> {
  const recovered = await AgentClient.findCustomerRunByDedupeKey(
    input.threadId,
    input.durableDedupeKey,
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
    dedupeKey: input.durableDedupeKey,
    signal: input.params.signal,
  })).runId;

  const stored = await prisma.agentTurn.updateMany({
    where: { id: input.turn.id, agentRunId: null, runLeaseOwner: input.leaseOwner },
    data: { agentRunId: runId, runLeaseOwner: null, runLeaseExpiresAt: null },
  });
  if (stored.count > 0) return runId;

  const current = await prisma.agentTurn.findUniqueOrThrow({
    where: { id: input.turn.id },
    select: { id: true, businessProfileId: true, conversationId: true, channel: true, agentRunId: true, status: true, decision: true },
  });
  assertTurnScope(current, input.params);
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
  const completed = await completedTurnResult(params);
  if (completed) return completed;
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

function customerTurnDedupeKey(params: CustomerTurnParams): string {
  // Encode only the caller-supplied local portion. A value that already looks
  // namespaced remains local data, so it cannot collide or be double-prefixed.
  return `customer:${params.businessProfileId}:${params.conversationId}:${params.channel}:${encodeURIComponent(params.dedupeKey)}`;
}

function leaseExpiry(now: Date): Date {
  return new Date(now.getTime() + LEASE_DURATION_MS);
}

async function claimRunLease(turnId: number, leaseOwner: string): Promise<boolean> {
  const now = new Date();
  const claimed = await prisma.agentTurn.updateMany({
    where: {
      id: turnId,
      agentRunId: null,
      OR: [{ runLeaseExpiresAt: null }, { runLeaseExpiresAt: { lt: now } }],
    },
    data: { runLeaseOwner: leaseOwner, runLeaseExpiresAt: leaseExpiry(now) },
  });
  return claimed.count > 0;
}

async function completeHistorySeedLease(params: CustomerTurnParams, owner: string): Promise<void> {
  const initialSeed = await prisma.conversation.updateMany({
    where: {
      id: params.conversationId, businessProfileId: params.businessProfileId,
      agentSeedLeaseOwner: owner, agentHistorySeededAt: null,
    },
    data: { agentHistorySeededAt: new Date(), agentSeedLeaseOwner: null, agentSeedLeaseExpiresAt: null },
  });
  if (initialSeed.count === 0) await releaseHistorySeedLease(params, owner);
}

async function releaseRunLease(turnId: number, owner: string): Promise<void> {
  await prisma.agentTurn.updateMany({
    where: { id: turnId, agentRunId: null, runLeaseOwner: owner },
    data: { runLeaseOwner: null, runLeaseExpiresAt: null },
  });
}

async function releaseHistorySeedLease(params: CustomerTurnParams, owner: string): Promise<void> {
  await prisma.conversation.updateMany({
    where: {
      id: params.conversationId, businessProfileId: params.businessProfileId,
      agentSeedLeaseOwner: owner,
    },
    data: { agentSeedLeaseOwner: null, agentSeedLeaseExpiresAt: null },
  });
}

function assertTurnScope(turn: Pick<PersistedTurn, "businessProfileId" | "conversationId" | "channel">, params: CustomerTurnParams): void {
  if (
    turn.businessProfileId !== params.businessProfileId ||
    turn.conversationId !== params.conversationId ||
    turn.channel !== params.channel
  ) {
    throw new Error("Customer agent turn does not belong to this conversation scope");
  }
}

async function completedTurnResult(params: CustomerTurnParams): Promise<CustomerTurnResult | null> {
  const turn = await prisma.agentTurn.findUnique({
    where: { dedupeKey: customerTurnDedupeKey(params) },
    select: { id: true, businessProfileId: true, conversationId: true, channel: true, agentRunId: true, status: true, decision: true },
  });
  if (!turn || turn.status !== "COMPLETED" || turn.decision == null) return null;
  assertTurnScope(turn, params);
  if (!turn.agentRunId) throw new Error("Completed customer agent turn is missing its run ID");
  const conversation = await ensureConversationThread(params);
  if (!conversation.agentThreadId) throw new Error("Customer conversation is missing an agent thread ID");
  return {
    agentTurnId: turn.id,
    threadId: conversation.agentThreadId,
    runId: turn.agentRunId,
    decision: customerAgentDecisionSchema.parse(turn.decision),
  };
}

function redactedFailureCode(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "CUSTOMER_AGENT_RUN_ABORTED") return "CUSTOMER_AGENT_RUN_ABORTED";
  if (error instanceof Error && /timeout/i.test(error.message)) return "CUSTOMER_AGENT_TIMEOUT";
  return "CUSTOMER_AGENT_FAILURE";
}
