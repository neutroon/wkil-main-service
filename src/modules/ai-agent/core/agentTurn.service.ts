import prisma from "@config/prisma";
import { logger } from "@utils/logger";

export type AgentTurnMode = "CUSTOMER_MESSAGE" | "ACTION_RESULT";
export type AgentTurnStatus = "RUNNING" | "WAITING_ACTION" | "COMPLETED" | "FAILED";

export async function createAgentTurn(params: {
  businessProfileId: number;
  conversationId: number;
  inputMessageId?: number | null;
  channel: string;
  mode: AgentTurnMode;
  customerText: string;
  parentActionRunId?: number | null;
  activeWorkflowId?: number | null;
}) {
  return prisma.agentTurn.create({
    data: {
      businessProfileId: params.businessProfileId,
      conversationId: params.conversationId,
      inputMessageId: params.inputMessageId ?? null,
      channel: params.channel,
      mode: params.mode,
      customerText: params.customerText,
      parentActionRunId: params.parentActionRunId ?? null,
      activeWorkflowId: params.activeWorkflowId ?? null,
      status: "RUNNING",
    },
  });
}

export async function updateAgentTurnStatus(
  id: number | undefined | null,
  status: AgentTurnStatus,
) {
  if (!id) return;
  try {
    await prisma.agentTurn.update({
      where: { id },
      data: { status },
    });
  } catch (error: any) {
    logger.warn("agent_turn.status_update_failed", {
      agentTurnId: id,
      status,
      error: error?.message || String(error),
    });
  }
}
