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
      await recordAiUsage({
        userId,
        businessProfileId,
        modelName: sessionStats.modelName,
        promptTokens: deltaPrompt,
        completionTokens: deltaCompletion,
        groundingCalls: deltaGrounding,
        operation: `chat_${channel || "direct"}`,
      });
    }

    logger.info("ai.node.recordUsage.success", {
      businessProfileId,
      model: sessionStats.modelName,
      promptTokens: sessionStats.promptTokens,
      completionTokens: sessionStats.completionTokens,
    });
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
