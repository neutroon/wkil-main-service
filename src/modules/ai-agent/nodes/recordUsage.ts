/**
 * Node: recordUsage
 *
 * Persists token usage and billing metrics to the database.
 * Calls the existing recordAiUsage() service — no changes to billing logic.
 *
 * This is the terminal node. After this, the graph exits and the
 * decision is returned to the caller (businessChatReply.service.ts).
 */
import { logger } from "@utils/logger";
import { enqueueAiUsageRecord } from "@modules/billing/billing.queue";
import { recordAiUsage } from "@modules/billing/billing.service";
import type { AgentStateType } from "@modules/ai-agent/core/agentState";

export async function recordUsageNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const { sessionStats, userId, businessProfileId, channel } = state;
  try {
    const deltaPrompt = Math.max(
      0,
      sessionStats.promptTokens - sessionStats.lastBilledPromptTokens,
    );
    const deltaCompletion = Math.max(
      0,
      sessionStats.completionTokens - sessionStats.lastBilledCompletionTokens,
    );
    const deltaGrounding = Math.max(
      0,
      sessionStats.groundingCalls - sessionStats.lastBilledGrounding,
    );

    if (deltaPrompt > 0 || deltaCompletion > 0 || deltaGrounding > 0) {
      void recordUsageInBackground({
        userId,
        businessProfileId,
        modelName: sessionStats.modelName,
        promptTokens: deltaPrompt,
        completionTokens: deltaCompletion,
        groundingCalls: deltaGrounding,
        operation: `chat_${channel || "direct"}`,
      }, {
        agentTurnId: state.agentTurnId,
        businessProfileId,
        modelName: sessionStats.modelName,
        totalPromptTokens: sessionStats.promptTokens,
        totalCompletionTokens: sessionStats.completionTokens,
      });
    }
  } catch (billingError: any) {
    // Billing failure must NEVER block the AI response.
    // Log the error but let the graph continue to completion.
    logger.error("ai.node.recordUsage.failed", {
      error: billingError.message,
      businessProfileId,
    });
  }

  // No state updates — this is a pure side-effect node
  return {};
}

async function recordUsageInBackground(
  usagePayload: Parameters<typeof recordAiUsage>[0],
  context: {
    agentTurnId?: number;
    businessProfileId: number;
    modelName: string;
    totalPromptTokens: number;
    totalCompletionTokens: number;
  },
) {
  try {
    await enqueueAiUsageRecord(usagePayload, {
      jobId: [
        "ai-usage-terminal",
        context.agentTurnId || "turn",
        context.modelName,
        usagePayload.promptTokens,
        usagePayload.completionTokens,
        usagePayload.groundingCalls,
      ].join("-"),
    });
    logger.info("ai.node.recordUsage.queued", {
      businessProfileId: context.businessProfileId,
      model: context.modelName,
      promptTokens: context.totalPromptTokens,
      completionTokens: context.totalCompletionTokens,
    });
  } catch (enqueueError: any) {
    logger.error("ai.node.recordUsage.enqueue_failed", {
      error: enqueueError.message,
      businessProfileId: context.businessProfileId,
    });

    try {
      await recordAiUsage(usagePayload);
    } catch (fallbackError: any) {
      logger.error("ai.node.recordUsage.fallback_failed", {
        error: fallbackError?.message || String(fallbackError),
        businessProfileId: context.businessProfileId,
      });
    }
  }
}
