/**
 * Node: callModel
 *
 * Provider-neutral chat model boundary backed by LangChain. The node owns
 * model mechanics only; product controls stay in backend nodes before/after it.
 */
import { logger } from "@utils/logger";
import { estimateSystemTokens, windowContents } from "../core/contextWindow";
import type { AgentStateType } from "../core/agentState";
import {
  addUsageToSessionStats,
  invokeDecision,
  invokeToolChoice,
  isRetryableProviderError,
} from "../core/modelRuntime";
import { buildAiRecoveryDecision, buildSystemRecoveryDecision } from "./recoveryDecision";

const BLOCKED_FINISH_REASONS = new Set(["SAFETY", "RECITATION"]);

export function normalizeModelFinishReason(reason?: string | null): string | null {
  return typeof reason === "string" && reason.trim()
    ? reason.trim().toUpperCase()
    : null;
}

export function shouldRejectModelOutput(params: {
  finishReason?: string | null;
  fullText: string;
  functionCallCount: number;
}): { reject: boolean; reason?: string } {
  const finishReason = normalizeModelFinishReason(params.finishReason);
  if (!finishReason) return { reject: false };
  if (BLOCKED_FINISH_REASONS.has(finishReason)) {
    return { reject: true, reason: finishReason };
  }

  const looksLikePartialStructuredReply =
    params.functionCallCount === 0 &&
    params.fullText.trim().startsWith("{") &&
    !params.fullText.trim().endsWith("}");

  if (finishReason === "MAX_TOKENS" && looksLikePartialStructuredReply) {
    return { reject: true, reason: "MAX_TOKENS" };
  }

  return { reject: false };
}

export async function callModelNode(
  state: AgentStateType,
): Promise<Partial<AgentStateType>> {
  const systemTokens = estimateSystemTokens(state.systemInstruction);
  const windowedContents = windowContents(state.contents, systemTokens);
  let sessionStats = state.sessionStats;

  try {
    if (state.tools?.length) {
      const toolChoice = await invokeToolChoice({
        systemInstruction: state.systemInstruction,
        contents: windowedContents,
        tools: state.tools,
      });

      sessionStats = addUsageToSessionStats(
        sessionStats,
        toolChoice.usage,
        toolChoice.modelName,
      );

      const outputRejection = shouldRejectModelOutput({
        finishReason: toolChoice.finishReason,
        fullText: toolChoice.rawText,
        functionCallCount: toolChoice.toolCalls.length,
      });
      if (outputRejection.reject) {
        logger.warn("ai.node.callModel.provider_output_rejected", {
          finishReason: outputRejection.reason,
          businessProfileId: state.businessProfileId,
          channel: state.channel,
          textLength: toolChoice.rawText.length,
          functionCallCount: toolChoice.toolCalls.length,
        });

        return {
          decision: await buildAiRecoveryDecision(state, {
            action: "REPLY_AUTO",
            reasoning: `Model output was rejected before parsing because the provider finished with ${outputRejection.reason}.`,
            failureReason: `model_output_${String(outputRejection.reason).toLowerCase()}`,
            emergencyFallback: state.policy.fallbackTemplates.unverified,
            allowHandoffLanguage: false,
            requiresGrounding: false,
            missingInfo: null,
          }),
          sessionStats,
        };
      }

      if (toolChoice.toolCalls.length > 0) {
        logger.info("ai.node.callModel.tool_calls", {
          model: toolChoice.modelName,
          turnCount: state.turnCount + 1,
          toolCalls: toolChoice.toolCalls.map((call) => call.name),
          businessProfileId: state.businessProfileId,
        });

        return {
          contents: [
            ...state.contents,
            {
              role: "model" as const,
              content: toolChoice.rawText,
              toolCalls: toolChoice.toolCalls,
            },
          ],
          toolCalls: toolChoice.toolCalls,
          turnCount: state.turnCount + 1,
          sessionStats,
        };
      }
    }

    const decisionResult = await invokeDecision({
      systemInstruction: state.systemInstruction,
      contents: windowedContents,
    });
    sessionStats = addUsageToSessionStats(
      sessionStats,
      decisionResult.usage,
      decisionResult.modelName,
    );

    const outputRejection = shouldRejectModelOutput({
      finishReason: decisionResult.finishReason,
      fullText: decisionResult.rawText,
      functionCallCount: 0,
    });
    if (outputRejection.reject) {
      return {
        decision: await buildAiRecoveryDecision(state, {
          action: "REPLY_AUTO",
          reasoning: `Model structured output was rejected before parsing because the provider finished with ${outputRejection.reason}.`,
          failureReason: `model_output_${String(outputRejection.reason).toLowerCase()}`,
          emergencyFallback: state.policy.fallbackTemplates.unverified,
          allowHandoffLanguage: false,
          requiresGrounding: false,
          missingInfo: null,
        }),
        sessionStats,
      };
    }

    logger.info("ai.node.callModel.decision", {
      model: decisionResult.modelName,
      turnCount: state.turnCount + 1,
      businessProfileId: state.businessProfileId,
      action: decisionResult.decision.action,
      replyType: decisionResult.decision.replyType,
    });

    return {
      contents: [
        ...state.contents,
        {
          role: "model" as const,
          content: decisionResult.rawText,
        },
      ],
      toolCalls: [],
      turnCount: state.turnCount + 1,
      sessionStats,
    };
  } catch (error: any) {
    const isTimeout =
      error?.message === "MODEL_TIMEOUT" ||
      error?.name === "AbortError" ||
      String(error?.message || "").toLowerCase().includes("timeout");
    const isTransientProviderFailure = isTimeout || isRetryableProviderError(error);

    logger.error("ai.node.callModel.failed", {
      isTimeout,
      isTransientProviderFailure,
      error: error?.message || String(error),
      businessProfileId: state.businessProfileId,
      channel: state.channel,
    });

    return {
      decision: await buildSystemRecoveryDecision(state, {
        reasoning: isTimeout
          ? "Provider timed out before returning a safe structured decision."
          : `Provider failed before returning a safe structured decision: ${error?.message || String(error)}`,
        failureReason: isTimeout ? "provider_timeout" : "provider_failure",
        handoffCategory: isTimeout ? "SYSTEM_TIMEOUT" : "SYSTEM_ERROR",
      }),
      sessionStats,
    };
  }
}
