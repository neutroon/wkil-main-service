import prisma from "@config/prisma";
import { syncHandoffRequested } from "@modules/realtime/socketSync.service";
import { logger } from "@utils/logger";
import {
  customerAgentDecisionSchema,
  type CustomerAgentDecision,
} from "./customerAgent.types";

type PersistedMessage = {
  id: number;
  conversationId: number;
  agentTurnId: number | null;
  content: string;
  status: "SENDING" | "SENT" | "DELIVERED" | "READ" | "FAILED";
  externalId: string | null;
};

export type CustomerDeliveryResult = { externalId?: string | null } | void;
export type CustomerDeliveryAdapter = (message: PersistedMessage) => Promise<CustomerDeliveryResult>;

/**
 * Channel adapters throw this when a timeout or connection break leaves the
 * provider outcome unknown. The row remains SENDING and must be reconciled
 * from provider receipts instead of being automatically sent again.
 */
export class CustomerDeliveryAmbiguousError extends Error {
  constructor(message = "Customer delivery outcome is ambiguous") {
    super(message);
    this.name = "CustomerDeliveryAmbiguousError";
  }
}

export function classifyCustomerDeliveryError(error: unknown): unknown {
  if (error instanceof CustomerDeliveryAmbiguousError) return error;
  if (!(error instanceof Error)) return error;
  const code = (error as Error & { code?: string }).code;
  if (
    (code && [
      "ECONNRESET", "ECONNABORTED", "ECONNREFUSED", "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
    ].includes(code)) ||
    error.name === "AbortError" ||
    /(?:network|socket|disconnect|connection reset|timed? ?out|fetch failed)/i.test(error.message)
  ) {
    return new CustomerDeliveryAmbiguousError("Customer delivery transport outcome is ambiguous");
  }
  return error;
}

export type ApplyCustomerDecisionParams = {
  businessProfileId: number;
  conversationId: number;
  agentTurnId: number;
  decision: CustomerAgentDecision;
  /** Sends the already-persisted message through the channel adapter. */
  deliver: CustomerDeliveryAdapter;
  /** Distinguishes generated follow-ups from normal customer-agent replies. */
  origin?: string;
};

export type ApplyCustomerDecisionResult =
  | { action: "REPLY"; delivery: "sent" | "already_sent" | "pending"; message: PersistedMessage }
  | { action: "HANDOFF"; message: PersistedMessage }
  | { action: "RESOLVE" }
  | { action: "NO_REPLY" };

const DELIVERED_STATUSES = new Set<PersistedMessage["status"]>(["SENT", "DELIVERED", "READ"]);

/**
 * Applies a completed customer-agent decision exactly at the Node boundary.
 *
 * The database transition to SENDING is the delivery claim. A process failure
 * after that claim but before provider confirmation is intentionally treated
 * as ambiguous: a later retry returns `pending` instead of risking a duplicate
 * customer message. Failed provider calls are explicitly marked FAILED and may
 * be retried without running the model again.
 */
export async function applyCustomerDecision(
  params: ApplyCustomerDecisionParams,
): Promise<ApplyCustomerDecisionResult> {
  const decision = customerAgentDecisionSchema.parse(params.decision);
  await assertDecisionScope(params);

  if (decision.action === "REPLY") return applyReply(params, decision);
  if (decision.action === "HANDOFF") return applyHandoff(params, decision);
  if (decision.action === "RESOLVE") {
    await prisma.conversation.updateMany({
      where: { id: params.conversationId, businessProfileId: params.businessProfileId },
      data: { status: "RESOLVED" },
    });
    return { action: "RESOLVE" };
  }
  return { action: "NO_REPLY" };
}

async function assertDecisionScope(params: ApplyCustomerDecisionParams): Promise<void> {
  const [conversation, turn] = await Promise.all([
    prisma.conversation.findFirst({
      where: { id: params.conversationId, businessProfileId: params.businessProfileId },
      select: { id: true },
    }),
    prisma.agentTurn.findFirst({
      where: {
        id: params.agentTurnId,
        businessProfileId: params.businessProfileId,
        conversationId: params.conversationId,
      },
      select: { id: true },
    }),
  ]);
  if (!conversation || !turn) throw new Error("Customer decision does not belong to this conversation scope");
}

async function applyReply(
  params: ApplyCustomerDecisionParams,
  decision: CustomerAgentDecision,
): Promise<ApplyCustomerDecisionResult> {
  const existing = await getMessageForTurn(params);
  const created = existing ? null : await createReplyMessage(params, decision.content!);
  const message = existing ?? created!.message;
  assertMessageScope(message, params);

  if (created?.created) return deliverAndFinalize(params, message);

  if (DELIVERED_STATUSES.has(message.status)) {
    return { action: "REPLY", delivery: "already_sent", message };
  }
  if (message.status === "SENDING") {
    return { action: "REPLY", delivery: "pending", message };
  }

  // Only FAILED rows are retryable. The conditional transition prevents two
  // workers that received the same durable turn from both calling the provider.
  const claim = await prisma.conversationMessage.updateMany({
    where: {
      id: message.id,
      conversationId: params.conversationId,
      agentTurnId: params.agentTurnId,
      status: "FAILED",
    },
    data: { status: "SENDING", externalId: null },
  });
  if (claim.count !== 1) {
    const current = await getMessageForTurn(params);
    if (!current) throw new Error("Customer decision output message disappeared during retry");
    assertMessageScope(current, params);
    if (DELIVERED_STATUSES.has(current.status)) return { action: "REPLY", delivery: "already_sent", message: current };
    return { action: "REPLY", delivery: "pending", message: current };
  }

  const sendingMessage = { ...message, status: "SENDING" as const, externalId: null };
  return deliverAndFinalize(params, sendingMessage);
}

async function createReplyMessage(
  params: ApplyCustomerDecisionParams,
  content: string,
): Promise<{ message: PersistedMessage; created: boolean }> {
  try {
    const message = await prisma.conversationMessage.create({
      data: {
        conversationId: params.conversationId,
        agentTurnId: params.agentTurnId,
        role: "model",
        content,
        status: "SENDING",
        origin: params.origin ?? "customer_agent",
      },
    });
    return { message, created: true };
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const concurrent = await getMessageForTurn(params);
    if (!concurrent) throw error;
    return { message: concurrent, created: false };
  }
}

async function deliverAndFinalize(
  params: ApplyCustomerDecisionParams,
  message: PersistedMessage,
): Promise<ApplyCustomerDecisionResult> {
  // Re-check human control at the last durable boundary before provider I/O.
  // A takeover after this claim can only race with an already in-flight
  // provider request; that unavoidable boundary remains reconciled by the
  // persisted SENDING row and provider receipts.
  const deliveryBoundary = await prisma.conversationMessage.updateMany({
    where: {
      id: message.id,
      conversationId: params.conversationId,
      agentTurnId: params.agentTurnId,
      status: "SENDING",
      conversation: { is: { businessProfileId: params.businessProfileId, aiEnabled: true } },
    },
    data: { status: "SENDING" },
  });
  if (deliveryBoundary.count !== 1) {
    return { action: "REPLY", delivery: "pending", message };
  }

  let provider: CustomerDeliveryResult;
  try {
    provider = await params.deliver(message);
  } catch (error) {
    if (error instanceof CustomerDeliveryAmbiguousError) throw error;
    await prisma.conversationMessage.updateMany({
      where: {
        id: message.id,
        conversationId: params.conversationId,
        agentTurnId: params.agentTurnId,
        status: "SENDING",
      },
      data: { status: "FAILED" },
    }).catch(() => undefined);
    throw error;
  }

  const externalId = provider?.externalId ?? null;
  try {
    const persisted = await prisma.conversationMessage.updateMany({
      where: {
        id: message.id,
        conversationId: params.conversationId,
        agentTurnId: params.agentTurnId,
        status: "SENDING",
      },
      data: { status: "SENT", externalId },
    });
    if (persisted.count !== 1) {
      const current = await getMessageForTurn(params);
      if (!current || !DELIVERED_STATUSES.has(current.status)) {
        throw new Error("Customer delivery confirmation was not persisted");
      }
    }
  } catch (error) {
    // The provider has already accepted the send. Never make this row
    // retryable when local confirmation fails, or a retry could duplicate it.
    const ambiguous = new CustomerDeliveryAmbiguousError(
      "Customer delivery was accepted but local confirmation is ambiguous",
    );
    Object.defineProperty(ambiguous, "cause", { value: error, configurable: true });
    throw ambiguous;
  }

  // The scheduler itself re-validates the persisted SENT trigger. Do this
  // after provider success only, so failed or ambiguous sends never nudge a
  // customer later. Scheduling must not reverse a completed delivery.
  try {
    const { scheduleConversationFollowUps } = await import("@modules/follow-up/followUp.service");
    await scheduleConversationFollowUps({
      businessProfileId: params.businessProfileId,
      conversationId: params.conversationId,
      triggerMessageId: message.id,
    });
  } catch (error) {
    logger.warn("customer_decision.follow_up_schedule_failed", {
      businessProfileId: params.businessProfileId,
      conversationId: params.conversationId,
      messageId: message.id,
    });
  }
  return {
    action: "REPLY",
    delivery: "sent",
    message: { ...message, status: "SENT", externalId },
  };
}

async function applyHandoff(
  params: ApplyCustomerDecisionParams,
  decision: CustomerAgentDecision,
): Promise<ApplyCustomerDecisionResult> {
  const category = decision.handoff_category ?? "OTHER";
  await prisma.conversation.updateMany({
    where: { id: params.conversationId, businessProfileId: params.businessProfileId },
    data: { aiEnabled: false, status: "OPEN" },
  });

  // Dynamic import avoids a service cycle when the follow-up worker later
  // invokes this decision applier for its own completed turns.
  const { cancelConversationFollowUps } = await import("@modules/follow-up/followUp.service");
  await cancelConversationFollowUps(params.conversationId);

  const existing = await getMessageForTurn(params);
  const message = existing ?? await createHandoffAudit(params, category);
  assertMessageScope(message, params);

  // Socket delivery is intentionally at-least-once. The audit row is durable
  // before this call, so a retry can safely repeat the lightweight UI sync.
  syncHandoffRequested({
    businessProfileId: params.businessProfileId,
    conversationId: params.conversationId,
    message,
  });
  return { action: "HANDOFF", message };
}

async function createHandoffAudit(
  params: ApplyCustomerDecisionParams,
  category: string,
): Promise<PersistedMessage> {
  try {
    return await prisma.conversationMessage.create({
      data: {
        conversationId: params.conversationId,
        agentTurnId: params.agentTurnId,
        role: "agent",
        content: "Human handoff requested.",
        status: "SENT",
        handoffCategory: category,
        origin: "customer_agent_handoff",
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const concurrent = await getMessageForTurn(params);
    if (!concurrent) throw error;
    return concurrent;
  }
}

async function getMessageForTurn(params: ApplyCustomerDecisionParams): Promise<PersistedMessage | null> {
  return prisma.conversationMessage.findUnique({ where: { agentTurnId: params.agentTurnId } });
}

function assertMessageScope(message: PersistedMessage, params: ApplyCustomerDecisionParams): void {
  if (message.conversationId !== params.conversationId || message.agentTurnId !== params.agentTurnId) {
    throw new Error("Customer decision output does not belong to this conversation scope");
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error &&
    (error as { code?: unknown }).code === "P2002";
}
